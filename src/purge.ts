/**
 * Destroy a deleted site: drop its tables, remove its organization (which frees
 * the slug) and clear its control-plane records. Irreversible, so it only runs
 * for a site that is in the `deleted` state.
 */
import { sql } from "kysely";
import { runAsSite } from "./dialect.ts";
import { controlDb, forgetSiteState, readSiteState } from "./registry.ts";
import { isTableOfSite, STATE_KEY_PREFIX } from "./rules.ts";
import { scopeState } from "./scope.ts";

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const ORG_COLLECTIONS = ["members", "invitations", "teams", "teamMembers", "organizationRoles"];

/**
 * SQLite refuses to drop a table whose foreign key points at a table that is
 * already gone ("no such table: main.users$acme"). Children are dropped before
 * parents when the order allows, but the order is not known up front, so when
 * that error names a table of this site, put a one-column stand-in in its place,
 * drop, and remove the stand-in again.
 */
async function dropTable(db: ReturnType<typeof controlDb>, slug: string, name: string): Promise<void> {
	try {
		await sql.raw(`DROP TABLE ${quote(name)}`).execute(db);
	} catch (error) {
		const missing = /no such table: main\.([^:]+):/.exec(String((error as Error)?.message ?? error))?.[1];
		if (!missing || !isTableOfSite(missing, slug)) throw error;
		await sql.raw(`CREATE TABLE IF NOT EXISTS ${quote(missing)} (id TEXT PRIMARY KEY)`).execute(db);
		try {
			await sql.raw(`DROP TABLE ${quote(name)}`).execute(db);
		} finally {
			await sql.raw(`DROP TABLE IF EXISTS ${quote(missing)}`).execute(db);
		}
	}
}

export async function purgeSite(slug: string): Promise<{ dropped: number; remaining: number }> {
	if ((await readSiteState(slug))?.state !== "deleted") throw new Error(`[multisite] refusing to purge "${slug}": not deleted`);
	const db = controlDb();
	const primary = scopeState().primary;

	return runAsSite(primary, async () => {
		const all = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%$%'`.execute(db);
		let todo = all.rows.map((r) => r.name).filter((n) => isTableOfSite(n, slug));
		let dropped = 0;
		// Foreign keys point child -> parent, so a parent cannot be dropped while children
		// exist. Keep making passes until nothing more can be dropped.
		for (let pass = 0; pass < 6 && todo.length; pass++) {
			const failed: string[] = [];
			for (const name of todo) {
				// A full-text drop removes its shadow tables too, so one may already be gone.
				const stillThere = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ${name}`.execute(db);
				if (!Number(stillThere.rows[0]?.n)) {
					dropped++;
					continue;
				}
				try {
					await dropTable(db, slug, name);
					dropped++;
				} catch {
					failed.push(name);
				}
			}
			if (failed.length === todo.length) break;
			todo = failed;
		}
		if (todo.length) return { dropped, remaining: todo.length };

		// Organization and its members/invitations/teams on the control plane.
		const orgs = await sql<{ id: string; data: string }>`SELECT id, data FROM _plugin_storage WHERE collection = 'organizations'`.execute(db);
		const org = orgs.rows.find((r) => {
			try {
				return (JSON.parse(r.data) as { slug?: string }).slug === slug;
			} catch {
				return false;
			}
		});
		if (org) {
			for (const c of ORG_COLLECTIONS) {
				await sql`DELETE FROM _plugin_storage WHERE collection = ${c} AND data LIKE ${`%"organizationId":"${org.id}"%`}`.execute(db);
			}
			await sql`DELETE FROM _plugin_storage WHERE collection = 'organizations' AND id = ${org.id}`.execute(db);
		}
		await sql`DELETE FROM options WHERE name IN (${`multisite:site:${slug}`}, ${STATE_KEY_PREFIX + slug})`.execute(db);
		forgetSiteState(slug);
		return { dropped, remaining: 0 };
	});
}
