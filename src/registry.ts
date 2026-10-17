/**
 * Read-side of the control plane: which organizations (= sites) exist, who owns
 * them, and whether a user may create another. Better Auth keeps orgs and
 * members in plugin storage on the primary site; we read them directly so no
 * HTTP round trip (and no change to the open-source plugin) is needed.
 */
import { Kysely, sql } from "kysely";
import { getDb } from "emdash/runtime";
import { currentSite, siteDialect, runAsSite } from "./dialect.ts";
import { platformEnv } from "./platform-env.ts";
import { scopeState } from "./scope.ts";
import {
	STATE_KEY_PREFIX,
	parseSiteState,
	planLimits,
	limitsForPlan,
	type Limits,
	type SiteState,
	type SiteStatus,
} from "./rules.ts";

/**
 * Make sure the shared inner dialect exists. On a cold isolate our outer
 * middleware runs BEFORE EmDash initialises its database, so the first request
 * to one of our routes would otherwise find nothing to connect with
 * ("database not initialised yet", HTTP 500). `getDb()` only builds the dialect.
 */
export async function warm(): Promise<void> {
	if (!scopeState().inner) await getDb();
}

/**
 * Control-plane connection: the shared inner driver, site chosen per query by
 * `runAsSite` only. It must NOT use the request's own site (`activeSite`): code
 * that runs inside a tenant's request (a plugin route in the site's admin) still
 * has to read the control plane, and the request's site would win over
 * `runAsSite(primary)` and make it read the tenant's tables instead.
 */
export function controlDb(): Kysely<never> {
	const st = scopeState();
	if (!st.inner) throw new Error("[multisite] database not initialised yet");
	return new Kysely<never>({ dialect: siteDialect(st.inner, () => currentSite() ?? st.primary, st.primary) });
}

export interface OrgRecord {
	id: string;
	slug: string;
	name: string;
	ownerUserId: string | null;
	/** Everyone in the org with their Better Auth role (owner, admin, member). */
	members: Array<{ userId: string; role: string }>;
	createdAt: string | null;
	/** Better Auth `metadata` (a JSON string or object, depending on the writer). */
	metadata: unknown;
}

const parse = <T>(s: string): T | null => {
	try {
		return JSON.parse(s) as T;
	} catch {
		return null;
	}
};

/** Every organization with its owner. Two plain reads of the primary's plugin storage. */
export async function readOrgs(): Promise<OrgRecord[]> {
	const db = controlDb();
	return runAsSite(scopeState().primary, async () => {
		const orgs = await sql<{ data: string }>`SELECT data FROM _plugin_storage WHERE collection = 'organizations'`.execute(db);
		const members = await sql<{ data: string }>`SELECT data FROM _plugin_storage WHERE collection = 'members'`.execute(db);
		const ownerByOrg = new Map<string, string>();
		const membersByOrg = new Map<string, Array<{ userId: string; role: string }>>();
		for (const r of members.rows) {
			const m = parse<{ organizationId?: string; userId?: string; role?: string }>(r.data);
			if (!m?.organizationId || !m.userId) continue;
			if (m.role === "owner") ownerByOrg.set(m.organizationId, m.userId);
			const list = membersByOrg.get(m.organizationId) ?? [];
			list.push({ userId: m.userId, role: m.role ?? "member" });
			membersByOrg.set(m.organizationId, list);
		}
		const out: OrgRecord[] = [];
		for (const r of orgs.rows) {
			const o = parse<{ id?: string; slug?: string; name?: string; createdAt?: string; metadata?: unknown }>(r.data);
			if (!o?.slug || !o.id) continue;
			out.push({
				id: o.id,
				slug: o.slug,
				name: o.name ?? o.slug,
				ownerUserId: ownerByOrg.get(o.id) ?? null,
				members: membersByOrg.get(o.id) ?? [],
				createdAt: o.createdAt ?? null,
				metadata: o.metadata ?? null,
			});
		}
		return out;
	});
}

/** Has this user verified their email on the control plane? */
export async function isEmailVerified(userId: string): Promise<boolean> {
	const db = controlDb();
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ v: number }>`SELECT email_verified AS v FROM users WHERE id = ${userId}`.execute(db),
	);
	return Number(r.rows[0]?.v ?? 0) === 1;
}

/**
 * The plan name of a user's active (or trialing) Better Auth / Stripe
 * subscription, or `null` when they have none (the free tier). Reads the
 * control-plane `subscriptions` plugin-storage collection, where
 * `@better-auth/stripe` stores one row per subscription keyed by `referenceId`
 * (the user id, our default). Only an "active" or "trialing" status counts; a
 * canceled/incomplete sub is treated as no plan. Never throws — a read failure
 * degrades to `null` (free tier), the safe direction.
 * ponytail: O(subscriptions-for-this-user) JSON scan in app code because the
 * value is a JSON blob, not columns. Fine (a user has one, maybe two rows).
 * Upgrade path: index `referenceId` + `status` if this ever gets hot.
 */
export async function readActivePlan(userId: string): Promise<string | null> {
	try {
		const db = controlDb();
		const r = await runAsSite(scopeState().primary, () =>
			sql<{ data: string }>`SELECT data FROM _plugin_storage WHERE collection = 'subscriptions'`.execute(db),
		);
		for (const row of r.rows) {
			let sub: { referenceId?: unknown; plan?: unknown; status?: unknown };
			try {
				sub = JSON.parse(row.data);
			} catch {
				continue;
			}
			if (sub.referenceId !== userId) continue;
			if (sub.status === "active" || sub.status === "trialing") {
				return typeof sub.plan === "string" ? sub.plan : null;
			}
		}
	} catch {
		// Control plane unreadable — fall back to the free tier (safe).
	}
	return null;
}

/**
 * The entitlements the billing webhook stashed on a user from their Stripe plan
 * + subscription metadata (`users.data.planEntitlements`), or `null` when none.
 * This is the metadata-driven path: `emdash-better-auth`'s stripe webhook parses
 * the Stripe metadata once and writes the resolved caps here, so we read them
 * with no Stripe call. Only the keys we enforce are picked out. Never throws.
 */
export async function readUserEntitlements(userId: string): Promise<Limits | null> {
	try {
		const db = controlDb();
		const r = await runAsSite(scopeState().primary, () =>
			sql<{ data: string | null }>`SELECT data FROM users WHERE id = ${userId}`.execute(db),
		);
		const dataJson = r.rows[0]?.data;
		if (!dataJson) return null;
		const ent = (JSON.parse(dataJson) as { planEntitlements?: unknown }).planEntitlements;
		if (!ent || typeof ent !== "object") return null;
		const e = ent as Record<string, unknown>;
		const out: Limits = {};
		if (typeof e.sitesPerUser === "number") out.sitesPerUser = e.sitesPerUser;
		if (typeof e.mediaBytesPerSite === "number") out.mediaBytesPerSite = e.mediaBytesPerSite;
		return Object.keys(out).length > 0 ? out : null;
	} catch {
		return null;
	}
}

/**
 * Is Stripe billing turned on for the platform? Reads the control-plane
 * `emdash-better-auth` setting. Only when this is true does the Better Auth UI
 * expose `/account/billing`, so the console gates its "Upgrade" link on it (the
 * route 404s otherwise). Never throws — defaults to off (no Upgrade link).
 */
export async function billingEnabled(): Promise<boolean> {
	try {
		const db = controlDb();
		const r = await runAsSite(scopeState().primary, () =>
			sql<{ value: string }>`SELECT value FROM options WHERE name = 'plugin:better-auth-settings:settings:billingEnabled'`.execute(db),
		);
		const v = r.rows[0]?.value;
		return v === "true" || v === '"true"' || v === "1";
	} catch {
		return false;
	}
}

/**
 * The effective limits for a user: their active plan's limits merged over the
 * host's configured limits. A user with no active subscription gets the free
 * tier. This is the resolver OP-11 called for — the create guard feeds its
 * result to `createProblem`/`lostLimitRace` in place of the static
 * `effectiveLimits(sites.limits)`.
 */
export async function resolveLimits(userId: string, configured: Limits | undefined): Promise<Limits> {
	// Precedence: metadata-driven entitlements (from the Stripe webhook, cover
	// per-plan AND per-customer overrides) > built-in plan map (fallback when no
	// metadata is set) > configured/default > free. The webhook has already
	// merged price + subscription metadata, so a non-null result here is the
	// authoritative per-user cap.
	const [plan, entitlements] = await Promise.all([
		readActivePlan(userId),
		readUserEntitlements(userId),
	]);
	const planPart = entitlements ?? planLimits(plan);
	return limitsForPlan(configured, planPart);
}

/** Does this site already have its tables? (A site that predates status rows has them but no status.) */
export async function siteHasTables(slug: string): Promise<boolean> {
	const db = controlDb();
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${`users$${slug}`}`.execute(db),
	);
	return Number(r.rows[0]?.n ?? 0) > 0;
}

const KNOWN = Symbol.for("emdash-multisite:known-sites");
const KNOWN_TTL_MS = 15_000;
const UNKNOWN_TTL_MS = 10_000;
/**
 * Does this site exist (have tables)? Asked on every tenant request, BEFORE the site's runtime starts:
 * starting it runs EmDash's migrations, so with wildcard DNS a request for ANY subdomain would otherwise
 * create ~90 tables for a site nobody made (and a purged site would come back to life). Memoised per
 * isolate: a known site for 15 s (shorter than the 30 s state memo, so right after a purge a stale "exists" ends first), an unknown one for 10 s (so a flood of random names costs one read
 * per name per 10 s, not one per request).
 * ponytail: the memo holds at most 2000 names, then starts over. Upgrade path: a Cloudflare rate limit on unknown hosts.
 */
/** Forget what we know about a site (this isolate only), e.g. right after its purge. */
export function forgetKnownSite(slug: string): void {
	(globalThis as Record<symbol, Map<string, unknown> | undefined>)[KNOWN]?.delete(slug);
}
export async function siteExists(slug: string): Promise<boolean> {
	const g = globalThis as Record<symbol, Map<string, { ok: boolean; expires: number }> | undefined>;
	const memo = (g[KNOWN] ??= new Map());
	const hit = memo.get(slug);
	if (hit && hit.expires > Date.now()) return hit.ok;
	const ok = await siteHasTables(slug);
	if (memo.size > 2000) memo.clear();
	memo.set(slug, { ok, expires: Date.now() + (ok ? KNOWN_TTL_MS : UNKNOWN_TTL_MS) });
	return ok;
}

/** Provisioning status of every site, keyed by slug. */
export async function readAllStatuses(): Promise<Map<string, SiteStatus>> {
	const db = controlDb();
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ name: string; value: string }>`SELECT name, value FROM options WHERE name LIKE 'multisite:site:%'`.execute(db),
	);
	const out = new Map<string, SiteStatus>();
	for (const row of r.rows) {
		const v = parse<SiteStatus>(row.value);
		if (v) out.set(row.name.slice("multisite:site:".length), v);
	}
	return out;
}

// Per-site theme, memoised briefly. A plain module variable would be duplicated
// across bundle chunks, so it lives on globalThis like the other multisite state.
const THEME_MEMO = Symbol.for("emdash-multisite:theme-memo");
const THEME_TTL_MS = 60_000;
type Memo = Map<string, { theme: string | null; expires: number }>;
const themeMemo = (): Memo => ((globalThis as Record<symbol, unknown>)[THEME_MEMO] ??= new Map()) as Memo;

/**
 * The theme id recorded for `site` (`multisite:theme`), or null when none is
 * set (the control plane, or a site that predates themes). Cached for a minute
 * per isolate: it runs on every public request, and the value only changes
 * when a site is provisioned. Failures (tables not created yet) are not cached.
 */
export function forgetSiteTheme(site: string): void {
	themeMemo().delete(site);
}

export async function readSiteTheme(site: string): Promise<string | null> {
	const memo = themeMemo();
	const hit = memo.get(site);
	if (hit && hit.expires > Date.now()) return hit.theme;
	try {
		const db = controlDb();
		const r = await runAsSite(site, () =>
			sql<{ value: string }>`SELECT value FROM options WHERE name = 'multisite:theme'`.execute(db),
		);
		const raw = r.rows[0]?.value;
		const parsed = raw ? (JSON.parse(raw) as unknown) : null;
		const theme = typeof parsed === "string" ? parsed : null;
		memo.set(site, { theme, expires: Date.now() + THEME_TTL_MS });
		return theme;
	} catch {
		return null;
	}
}

// ---- control plane -> tenant handoff ---------------------------------------

const SECRET_KEY = Symbol.for("emdash-multisite:handoff-secret");

/**
 * The key that signs handoff links. Generated once, stored on the control plane
 * (the only place that can mint a link), and read by tenants from there, so no
 * environment secret has to be shared between sites. Stored in D1 it is readable by anyone
 * who can read the database, so a Worker secret `MULTISITE_SECRET` (32+ characters) takes
 * precedence when the host sets one: `wrangler secret put MULTISITE_SECRET`.
 */
export async function handoffSecret(): Promise<string> {
	const g = globalThis as Record<symbol, string | undefined>;
	if (g[SECRET_KEY]) return g[SECRET_KEY]!;
	const fromEnv = (await platformEnv())?.MULTISITE_SECRET;
	if (typeof fromEnv === "string" && fromEnv.length >= 32) return (g[SECRET_KEY] = fromEnv);
	const db = controlDb();
	const read = () =>
		runAsSite(scopeState().primary, () =>
			sql<{ value: string }>`SELECT value FROM options WHERE name = 'multisite:handoff-secret'`.execute(db),
		);
	let value = (await read()).rows[0]?.value;
	if (!value) {
		const fresh = JSON.stringify(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
		await runAsSite(scopeState().primary, () =>
			sql`INSERT INTO options (name, value) VALUES ('multisite:handoff-secret', ${fresh}) ON CONFLICT(name) DO NOTHING`.execute(db),
		);
		value = (await read()).rows[0]?.value;
	}
	const secret = JSON.parse(value ?? "null") as string | null;
	if (!secret) throw new Error("[multisite] could not create the handoff secret");
	g[SECRET_KEY] = secret;
	return secret;
}

/**
 * Accept a handoff nonce once, on the tenant. Returns false if it was used before.
 * Expired nonces are swept in the same call so the table does not grow.
 */
export async function consumeHandoffNonce(site: string, nonce: string, exp: number): Promise<boolean> {
	const db = controlDb();
	return runAsSite(site, async () => {
		await sql`DELETE FROM options WHERE name LIKE 'multisite:handoff:%' AND CAST(value AS INTEGER) < ${Date.now()}`.execute(db);
		const r = await sql<{ name: string }>`
			INSERT INTO options (name, value) VALUES (${`multisite:handoff:${nonce}`}, ${String(exp)})
			ON CONFLICT(name) DO NOTHING RETURNING name`.execute(db);
		return r.rows.length === 1;
	});
}

/** Is `userId` an enabled user of `site`? */
export async function siteHasUser(site: string, userId: string): Promise<boolean> {
	const db = controlDb();
	const r = await runAsSite(site, () =>
		sql<{ id: string }>`SELECT id FROM users WHERE id = ${userId} AND disabled = 0`.execute(db),
	);
	return r.rows.length === 1;
}

// ---- suspend / delete state --------------------------------------------------

const STATE_MEMO = Symbol.for("emdash-multisite:state-memo");
const STATE_TTL_MS = 30_000;
type StateMemo = Map<string, { value: SiteState | null; expires: number }>;
const stateMemo = (): StateMemo => ((globalThis as Record<symbol, unknown>)[STATE_MEMO] ??= new Map()) as StateMemo;

/**
 * The site's suspend/delete state, read from the CONTROL PLANE (a tenant cannot
 * touch it). Runs on every tenant request, so it is memoised for 30 s per
 * isolate; a change made in this isolate takes effect immediately. On a read
 * failure it returns null (serve the site) and does not cache the miss.
 */
export async function readSiteState(site: string): Promise<SiteState | null> {
	const memo = stateMemo();
	const hit = memo.get(site);
	if (hit && hit.expires > Date.now()) return hit.value;
	try {
		const db = controlDb();
		const r = await runAsSite(scopeState().primary, () =>
			sql<{ value: string }>`SELECT value FROM options WHERE name = ${STATE_KEY_PREFIX + site}`.execute(db),
		);
		const value = parseSiteState(r.rows[0]?.value);
		memo.set(site, { value, expires: Date.now() + STATE_TTL_MS });
		return value;
	} catch {
		return null;
	}
}

export function forgetSiteState(site: string): void {
	stateMemo().delete(site);
}

/** Every site that is not active, keyed by slug. */
export async function readAllStates(): Promise<Map<string, SiteState>> {
	const db = controlDb();
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ name: string; value: string }>`SELECT name, value FROM options WHERE name LIKE ${`${STATE_KEY_PREFIX}%`}`.execute(db),
	);
	const out = new Map<string, SiteState>();
	for (const row of r.rows) {
		const v = parseSiteState(row.value);
		if (v) out.set(row.name.slice(STATE_KEY_PREFIX.length), v);
	}
	return out;
}

/** Set (or clear, with null) a site's state. */
export async function writeSiteState(site: string, state: SiteState | null): Promise<void> {
	const db = controlDb();
	await runAsSite(scopeState().primary, async () => {
		if (state) {
			await sql`INSERT INTO options (name, value) VALUES (${STATE_KEY_PREFIX + site}, ${JSON.stringify(state)})
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
		} else {
			await sql`DELETE FROM options WHERE name = ${STATE_KEY_PREFIX + site}`.execute(db);
		}
	});
	stateMemo().set(site, { value: state, expires: Date.now() + STATE_TTL_MS });
}
