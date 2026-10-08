/**
 * Read-side of the control plane: which organizations (= sites) exist, who owns
 * them, and whether a user may create another. Better Auth keeps orgs and
 * members in plugin storage on the primary site; we read them directly so no
 * HTTP round trip (and no change to the open-source plugin) is needed.
 */
import { Kysely, sql } from "kysely";
import { getDb } from "emdash/runtime";
import { siteDialect, runAsSite } from "./dialect.ts";
import { scopeState } from "./scope.ts";

/**
 * Make sure the shared inner dialect exists. On a cold isolate our outer
 * middleware runs BEFORE EmDash initialises its database, so the first request
 * to one of our routes would otherwise find nothing to connect with
 * ("database not initialised yet", HTTP 500). `getDb()` only builds the dialect.
 */
export async function warm(): Promise<void> {
	if (!scopeState().inner) await getDb();
}

/** Control-plane connection: the shared inner driver, site resolved per query. */
export function controlDb(): Kysely<never> {
	const st = scopeState();
	if (!st.inner) throw new Error("[multisite] database not initialised yet");
	return new Kysely<never>({ dialect: siteDialect(st.inner, st.activeSite, st.primary) });
}

export interface OrgRecord {
	id: string;
	slug: string;
	name: string;
	ownerUserId: string | null;
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
		for (const r of members.rows) {
			const m = parse<{ organizationId?: string; userId?: string; role?: string }>(r.data);
			if (m?.organizationId && m.userId && m.role === "owner") ownerByOrg.set(m.organizationId, m.userId);
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

/** Does this site already have its tables? (A site that predates status rows has them but no status.) */
export async function siteHasTables(slug: string): Promise<boolean> {
	const db = controlDb();
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ${`users$${slug}`}`.execute(db),
	);
	return Number(r.rows[0]?.n ?? 0) > 0;
}
