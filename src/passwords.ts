/**
 * Keep an owner's password the same on the control plane and on their sites.
 *
 * Provisioning copies the owner's Better Auth credential account into each site. A later password change or
 * reset on the control plane would leave those copies on the old password. After such a request (and on every
 * cron tick as a safety net) this copies recently changed credential accounts to the sites their user owns.
 *
 * Only owners: an editor who signed up on a site has a separate account there and keeps its own password.
 * ponytail: matches by "changed in the last N minutes", so a missed window (Worker down for longer than the cron
 * window) is not caught. Upgrade path: a per-account version stamp compared on every handoff.
 */
import { sql } from "kysely";
import { runAsSite } from "./dialect.ts";
import { log } from "./log.ts";
import { controlDb, readAllStates, readOrgs } from "./registry.ts";
import { scopeState } from "./scope.ts";

export const PASSWORD_PATHS: ReadonlySet<string> = new Set(["/api/auth/change-password", "/api/auth/reset-password", "/api/auth/set-password"]);

interface AccountRow {
	plugin_id: string;
	collection: string;
	id: string;
	data: string;
	created_at: string;
	updated_at: string;
	revision: string;
}

/** Copy credential accounts changed within `withinMs` to the sites their user owns. Returns how many site copies were updated. */
export async function syncRecentPasswords(withinMs: number): Promise<number> {
	const db = controlDb();
	const cutoff = new Date(Date.now() - withinMs).toISOString();
	const rows = await runAsSite(scopeState().primary, async () =>
		(await sql<AccountRow>`SELECT * FROM _plugin_storage WHERE collection = 'accounts' AND updated_at >= ${cutoff}`.execute(db)).rows,
	);
	const changed = rows.flatMap((r) => {
		try {
			const d = JSON.parse(r.data) as { providerId?: string; userId?: string };
			return d.providerId === "credential" && d.userId ? [{ row: r, userId: d.userId }] : [];
		} catch {
			return [];
		}
	});
	if (!changed.length) return 0;
	const inactive = await readAllStates();
	const orgs = (await readOrgs()).filter((o) => o.ownerUserId && !inactive.has(o.slug) && o.slug !== scopeState().primary);
	let n = 0;
	for (const { row, userId } of changed) {
		for (const org of orgs.filter((o) => o.ownerUserId === userId)) {
			await runAsSite(org.slug, () =>
				sql`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision)
					VALUES (${row.plugin_id}, ${row.collection}, ${row.id}, ${row.data}, ${row.created_at}, ${row.updated_at}, ${row.revision})
					ON CONFLICT(plugin_id, collection, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, revision = excluded.revision`.execute(db),
			).then(() => n++, (error) => console.error(`[multisite] password sync to "${org.slug}" failed:`, error));
		}
	}
	if (n) log("password.synced", { copies: n });
	return n;
}
