/**
 * "Creating an organization creates a site."
 *
 * Watches ONE Better Auth call on the control-plane site, POST
 * /api/auth/organization/create, without changing the (open-source) plugin:
 *   - before: rejects a slug that cannot be a site name;
 *   - after a 200: provisions the site in the background and tracks status.
 *
 * The org slug is the site id and therefore the subdomain: `acme` -> acme.<domain>.
 */
import { sql } from "kysely";
import { applySeed } from "emdash";
// @ts-ignore - virtual module provided by EmDash's integration (the bundled seed)
import { userSeed } from "virtual:emdash/seed";
import { runAsSite } from "./dialect.ts";
import { isSiteId } from "./rewrite.ts";
import { BUNDLED_THEME, DEFAULT_CONCURRENT_PROVISIONS, SLOT_WAIT_MS, STALE_PROVISIONING_MS, templateId, effectiveTheme, needsReconcile, themeFromMetadata, type ProvisionStep, type SiteStatus } from "./rules.ts";
import type { SitesConfig } from "./sites.ts";
import { controlDb, forgetSiteTheme, readAllStates, readOrgs, readSiteTheme, siteHasTables } from "./registry.ts";
import { scopeState } from "./scope.ts";
import { provisionWith } from "./provision.ts";
import { log } from "./log.ts";
import { cloneTemplate, hasTemplate } from "./clone-run.ts";
import { sitesConfig } from "./config.ts";
import { acquireSlot, releaseSlot } from "./slots.ts";
import { dropSiteTables } from "./purge.ts";

export { ORG_CREATE_PATH, RESERVED_SITE_IDS, parseCreatedOrg, slugProblem, type SiteStatus } from "./rules.ts";

const statusKey = (slug: string) => `multisite:site:${slug}`;

export async function readStatus(slug: string): Promise<SiteStatus | null> {
	const db = controlDb();
	const row = await runAsSite(scopeState().primary, () =>
		sql<{ value: string }>`SELECT value FROM options WHERE name = ${statusKey(slug)}`.execute(db),
	);
	const v = row.rows[0]?.value;
	return v ? (JSON.parse(v) as SiteStatus) : null;
}

export async function writeStatus(slug: string, s: SiteStatus): Promise<void> {
	const db = controlDb();
	await runAsSite(scopeState().primary, () =>
		sql`INSERT INTO options (name, value) VALUES (${statusKey(slug)}, ${JSON.stringify(s)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db),
	);
}

const BA_SETTINGS = "plugin:better-auth-settings:settings:";
/** Settings not inherited by customer sites: they decide for themselves. */
const NOT_INHERITED = new Set([`${BA_SETTINGS}orgEnabled`, `${BA_SETTINGS}teamsEnabled`, `${BA_SETTINGS}signUpEnabled`]);

/** Can visitors register on this site? Unset means open (Better Auth's default; sites made before the setting existed). */
export async function signUpOpen(slug: string): Promise<boolean> {
	const db = controlDb();
	const r = await runAsSite(slug, () => sql<{ value: string }>`SELECT value FROM options WHERE name = ${`${BA_SETTINGS}signUpEnabled`}`.execute(db));
	return r.rows[0]?.value !== "false";
}

const SIGNUP_MEMO = Symbol.for("emdash-multisite:signup-memo");
/** `signUpOpen`, remembered for 30 s per isolate: it is asked for on every public page view. */
export async function signUpOpenCached(slug: string): Promise<boolean> {
	const g = globalThis as Record<symbol, Map<string, { v: boolean; t: number }> | undefined>;
	const memo = (g[SIGNUP_MEMO] ??= new Map());
	const hit = memo.get(slug);
	if (hit && Date.now() - hit.t < 30_000) return hit.v;
	const v = await signUpOpen(slug);
	if (memo.size > 2000) memo.clear();
	memo.set(slug, { v, t: Date.now() });
	return v;
}

/** Free core's migration lock if it has been held longer than a provisioning run can last. */
async function releaseStaleLock(db: ReturnType<typeof controlDb>, slug: string): Promise<void> {
	const cutoff = Date.now() - STALE_PROVISIONING_MS;
	await runAsSite(slug, () =>
		sql`UPDATE _emdash_migrations_lock SET is_locked = 0 WHERE is_locked > 0 AND is_locked < ${cutoff}`
			.execute(db)
			.catch(() => {}), // first run: the table does not exist yet
	);
}

/**
 * A site's tables (core migrations, run as that site) and its starter content.
 * Migrations alone leave an empty schema with no collections, so without the
 * seed a new tenant has nothing to edit. core's applySeed upserts, so a retry is
 * safe. Media is not downloaded: see "Media (uploads)" in the README.
 */
async function buildSchemaAndSeed(
	db: ReturnType<typeof controlDb>,
	slug: string,
	seed: unknown,
	done?: (ended: ProvisionStep, next?: ProvisionStep) => Promise<void>,
): Promise<void> {
	await provisionWith(db, slug);
	await done?.("tables", "content");
	if (seed) {
		// eslint-disable-next-line typescript/no-explicit-any -- core types its own Database/Seed
		await runAsSite(slug, () => applySeed(db as any, seed as any, { includeContent: true, skipMediaDownload: true }));
	}
}

/**
 * Build the template site for a theme (`tpl-<theme>`): the pre-built copy that new
 * sites are cloned from. Slow (the full migrate-and-seed), so run it once, not per
 * customer. It has no owner and no organization. Refuses to overwrite unless `rebuild` is set, which
 * drops the template first (after an EmDash upgrade or a theme seed change). New sites made while it is
 * being rebuilt take the slow path.
 */
export async function buildTemplate(sites: SitesConfig, theme: string, opts: { rebuild?: boolean } = {}): Promise<"built" | "exists" | "unknown-theme"> {
	const seed = sites.themes?.[theme]?.seed;
	if (!seed) return "unknown-theme";
	const slug = templateId(theme);
	if (await hasTemplate(theme)) {
		if (!opts.rebuild) return "exists";
		const dropped = await runAsSite(scopeState().primary, () => dropSiteTables(slug));
		if (dropped.remaining) throw new Error(`[multisite] could not clear ${dropped.remaining} tables of ${slug}`);
	}
	await buildSchemaAndSeed(controlDb(), slug, seed);
	await runAsSite(slug, async () => {
		// Without this flag EmDash's APIs answer NOT_CONFIGURED (the template doubles as a public demo, whose
		// search needs them). Clones get it again from the identity step either way.
		await sql`INSERT INTO options (name, value) VALUES ('emdash:setup_complete', 'true')
			ON CONFLICT(name) DO UPDATE SET value = 'true'`.execute(controlDb());
		// Written last: it marks the template complete.
		await sql`INSERT INTO options (name, value) VALUES ('multisite:theme', ${JSON.stringify(theme)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(controlDb());
	});
	log("template.built", { theme });
	return "built";
}

/**
 * Create the site `slug` and hand it to `ownerUserId`. Idempotent: running it
 * again on a half-provisioned site completes it.
 */
export async function createSiteForOrg(
	org: { slug: string; name: string; ownerUserId: string },
	plan: { theme: string; seed?: unknown } = { theme: BUNDLED_THEME },
): Promise<void> {
	const st = scopeState();
	const startedAt = new Date().toISOString();
	await writeStatus(org.slug, { status: "provisioning", startedAt, step: "tables" });
	// Wait for one of the platform's provisioning slots; if none frees up soon, say "queued" and let the next poll or cron retry.
	const max = sitesConfig()?.limits?.concurrentProvisions ?? DEFAULT_CONCURRENT_PROVISIONS;
	if (!(await acquireSlot(org.slug, max, SLOT_WAIT_MS))) {
		await writeStatus(org.slug, { status: "provisioning", startedAt: new Date().toISOString(), step: "queued" });
		log("site.queued", { site: org.slug });
		return;
	}
	const timings: Partial<Record<ProvisionStep, number>> = {};
	let lap = Date.now();
	/** Record how long the step that just ended took, and announce the next one. */
	const done = async (ended: ProvisionStep, next?: ProvisionStep) => {
		const now = Date.now();
		timings[ended] = now - lap;
		lap = now;
		if (next) await writeStatus(org.slug, { status: "provisioning", startedAt, step: next });
	};
	try {
		const db = controlDb();

		// 0. a run that was killed mid-migration (Worker evicted) leaves core's
		//    migration lock held, and every retry then refuses to start. Release a
		//    lock old enough that its owner is certainly gone.
		await releaseStaleLock(db, org.slug);

		// 1. the site's tables and starter content: copied from the theme's template in one
		//    D1 batch when there is one, else core migrations + the theme's seed (slow: ~70 s).
		//    A site that already has tables is a retry of a partial run; it takes the slow path.
		const cloned = !(await siteHasTables(org.slug)) && (await cloneTemplate(plan.theme, org.slug));
		if (cloned) {
			await done("tables", "content");
		} else {
			await buildSchemaAndSeed(db, org.slug, plan.seed ?? userSeed, done);
		}
		await done("content", "identity");
		// 2. read the owner's identity and platform auth policy from the control plane
		const { owner, storage, inherited } = await runAsSite(st.primary, async () => {
			const u = await sql<Record<string, unknown>>`SELECT * FROM users WHERE id = ${org.ownerUserId}`.execute(db);
			const s = await sql<Record<string, unknown>>`
				SELECT * FROM _plugin_storage
				WHERE collection IN ('accounts', 'usernames') AND data LIKE ${`%"userId":"${org.ownerUserId}"%`}`.execute(db);
			const o = await sql<{ name: string; value: string }>`
				SELECT name, value FROM options WHERE name LIKE ${`${BA_SETTINGS}%`}`.execute(db);
			return { owner: u.rows[0], storage: s.rows, inherited: o.rows.filter((r) => !NOT_INHERITED.has(r.name)) };
		});
		if (!owner) throw new Error(`owner ${org.ownerUserId} not found on the control plane`);

		// 3. write them into the new site: owner becomes admin (role 50), verified
		await runAsSite(org.slug, async () => {
			await sql`INSERT INTO users (id, email, name, avatar_url, role, email_verified, data, created_at, updated_at, disabled)
				VALUES (${owner.id}, ${owner.email}, ${owner.name}, ${owner.avatar_url}, 50, 1, ${owner.data},
					${owner.created_at}, ${owner.updated_at}, 0)
				ON CONFLICT(id) DO UPDATE SET role = 50, email_verified = 1`.execute(db);
			for (const r of storage) {
				await sql`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision)
					VALUES (${r.plugin_id}, ${r.collection}, ${r.id}, ${r.data}, ${r.created_at}, ${r.updated_at}, ${r.revision})
					ON CONFLICT(plugin_id, collection, id) DO NOTHING`.execute(db);
			}
			for (const r of inherited) {
				await sql`INSERT INTO options (name, value) VALUES (${r.name}, ${r.value})
					ON CONFLICT(name) DO NOTHING`.execute(db);
			}
			// A new customer site is closed to public registration; its owner turns it on in Settings
			// ("Allow new sign-ups", emdash-better-auth 0.11) if they want subscribers. DO NOTHING so a
			// retry of provisioning never undoes the owner's choice.
			await sql`INSERT INTO options (name, value) VALUES (${`${BA_SETTINGS}signUpEnabled`}, 'false')
				ON CONFLICT(name) DO NOTHING`.execute(db);
			await sql`INSERT INTO options (name, value) VALUES ('multisite:theme', ${JSON.stringify(plan.theme)})
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
			await sql`INSERT INTO options (name, value) VALUES ('site:title', ${JSON.stringify(org.name)})
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
			// The site is born with an admin (the owner, above), so EmDash's
			// first-run setup wizard must never run on it. Without this flag the
			// wizard appears and then refuses ("admin user already exists").
			await sql`INSERT INTO options (name, value) VALUES ('emdash:setup_complete', 'true')
				ON CONFLICT(name) DO UPDATE SET value = 'true'`.execute(db);
		});

		await done("identity");
		await writeStatus(org.slug, { status: "ready", startedAt, readyAt: new Date().toISOString(), timings });
		log("site.ready", { site: org.slug, theme: plan.theme, cloned, ms: Date.now() - Date.parse(startedAt), timings });
	} catch (error) {
		console.error(`[multisite] provisioning "${org.slug}" failed:`, error);
		log("site.failed", { site: org.slug, error: error instanceof Error ? error.message : String(error) });
		await writeStatus(org.slug, {
			status: "failed",
			startedAt,
			error: error instanceof Error ? error.message : String(error),
		}).catch(() => {});
	} finally {
		await releaseSlot(org.slug).catch(() => {});
	}
}

/** Theme id and seed for a site, from what was requested at creation (org metadata). */
export function planFor(sites: SitesConfig, metadata: unknown): { theme: string; seed?: unknown } {
	const theme = effectiveTheme(themeFromMetadata(metadata), sites.themes, sites.defaultTheme);
	return { theme, seed: sites.themes?.[theme]?.seed };
}

/**
 * Sites that need provisioning (again): `failed`, a `provisioning` row old
 * enough to be a dead run, or no status row at all. A site with no status row
 * but with tables predates status tracking; it is adopted as `ready` instead of
 * being provisioned a second time on top of live content.
 */
export async function pendingReconcile(only?: string): Promise<string[]> {
	const out: string[] = [];
	// Suspended and deleted sites are left alone: provisioning would wake their runtime
	// and re-create what a purge removed.
	const inactive = await readAllStates();
	for (const org of await readOrgs()) {
		if (only && org.slug !== only) continue;
		if (!org.ownerUserId || !isSiteId(org.slug) || inactive.has(org.slug)) continue;
		const status = await readStatus(org.slug);
		if (!needsReconcile(status, Date.now())) continue;
		if (!status && (await siteHasTables(org.slug))) {
			const now = new Date().toISOString();
			await writeStatus(org.slug, { status: "ready", startedAt: now, readyAt: now });
			continue;
		}
		out.push(org.slug);
	}
	return out;
}

/**
 * Re-provision ONE stuck site (the first pending, or `only`). One per call on
 * purpose: a run is ~20 s of D1 work and the background budget after a response
 * (`waitUntil`) is ~30 s, so a loop would be killed half way and leave a site
 * stuck in `provisioning`. Call again for the next one.
 * ponytail: upgrade path is a Queue or Workflow that runs one site per message.
 */
export async function reconcile(sites: SitesConfig, only?: string): Promise<string[]> {
	const [slug] = await pendingReconcile(only);
	if (!slug) return [];
	const org = (await readOrgs()).find((o) => o.slug === slug)!;
	// A switched site keeps its current theme; the org metadata only records the first choice.
	const current = await readSiteTheme(slug);
	await createSiteForOrg({ slug, name: org.name, ownerUserId: org.ownerUserId! }, planFor(sites, current ? { theme: current } : org.metadata));
	return [slug];
}

/**
 * Switch a live site to another theme. Additive and non-destructive: the target
 * theme's seed is applied with skip-on-conflict (core creates only what is
 * missing, never overwrites settings, menus or content), then the site's theme
 * option is flipped. Content of the old theme stays in the database, hidden.
 */
export async function switchTheme(
	sites: SitesConfig,
	slug: string,
	theme: string,
	opts: { includeContent: boolean },
): Promise<void> {
	const seed = sites.themes?.[theme]?.seed;
	if (!seed) throw new Error(`unknown theme: ${theme}`);
	const db = controlDb();
	await runAsSite(slug, async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- core types its own Database/Seed
		await applySeed(db as any, seed as any, { includeContent: opts.includeContent, skipMediaDownload: true, onConflict: "skip" });
		await sql`INSERT INTO options (name, value) VALUES ('multisite:theme', ${JSON.stringify(theme)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
	});
	forgetSiteTheme(slug);
}
