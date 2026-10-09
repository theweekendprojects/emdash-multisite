/**
 * Per-site backup and restore. D1 Time Travel only restores the whole database, so a
 * single site that was damaged (or deleted by mistake) needs its own copy.
 *
 * A backup is one JSON file in the media bucket, outside every site's key prefix:
 *   _backups/<site>/<iso time>[-pre-restore].json
 *   { version, slug, createdAt, schema: [...], data: [...], triggers: [...] }
 * `schema` and `triggers` are the site's own CREATE statements; `data` is multi-row INSERTs whose
 * values come from SQLite's `quote()`, so text, numbers, NULL and blobs round-trip exactly.
 * Restore replays them in ONE D1 batch (atomic). The control-plane records (organization, state,
 * theme, status) are not part of a backup: they stay where they are.
 *
 * ponytail: each table is read in one query, so a table too big for one D1 response needs paging;
 * the control plane (primary site) is not backed up here (Time Travel covers it).
 */
import { sql } from "kysely";
import { clonePlan, insertStatements, retarget, type MasterRow } from "./clone.ts";
import { d1, type D1 } from "./clone-run.ts";
import { runAsSite } from "./dialect.ts";
import { mediaBucket, type Bucket } from "./media-bucket.ts";
import { dropSiteTables } from "./purge.ts";
import { controlDb, forgetSiteTheme, siteHasTables } from "./registry.ts";
import { BACKUP_KEEP, backupKey, backupPrefix } from "./rules.ts";
import { scopeState } from "./scope.ts";

export interface Backup {
	version: 1;
	slug: string;
	createdAt: string;
	schema: string[];
	data: string[];
	triggers: string[];
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const lastKey = (slug: string) => `multisite:backup:${slug}`;

async function needs(): Promise<{ db: D1; bucket: Bucket }> {
	const [db, bucket] = [await d1(), await mediaBucket()];
	if (!db || !bucket) throw new Error("[multisite] backups need the D1 and R2 (media) bindings");
	return { db, bucket };
}

/** Read a site's schema and rows. Two D1 round trips for the rows, however many tables. */
export async function exportSite(slug: string): Promise<Backup> {
	const { db } = await needs();
	const { results } = await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE instr(name, ?) > 0").bind(`$${slug}`).all<MasterRow>();
	const plan = clonePlan(results, slug, slug);
	if (!plan.tables.length) throw new Error(`[multisite] "${slug}" has no tables to back up`);
	const info = await db.batch(plan.tables.map((t) => db.prepare(`PRAGMA table_info(${quote(t)})`)));
	const columns = info.map((r) => (r.results as Array<{ name: string }>).map((c) => c.name));
	const rows = await db.batch(
		plan.tables.map((t, i) => db.prepare(`SELECT '(' || ${columns[i]!.map((c) => `quote(${quote(c)})`).join(" || ',' || ")} || ')' AS v FROM ${quote(t)}`)),
	);
	return {
		version: 1,
		slug,
		createdAt: new Date().toISOString(),
		schema: plan.schema,
		data: plan.tables.flatMap((t, i) => insertStatements(t, columns[i]!, (rows[i]!.results as Array<{ v: string }>).map((r) => r.v))),
		triggers: plan.triggers,
	};
}

/** Store a backup, drop the oldest beyond `BACKUP_KEEP`, and remember when it happened. */
export async function saveBackup(backup: Backup, tag?: string): Promise<{ key: string; bytes: number }> {
	const { bucket } = await needs();
	const key = backupKey(backup.slug, backup.createdAt, tag);
	const body = JSON.stringify(backup);
	await bucket.put(key, body);
	const keys = await listBackups(backup.slug);
	const old = keys.slice(0, Math.max(0, keys.length - BACKUP_KEEP));
	if (old.length) await bucket.delete(old);
	await runAsSite(scopeState().primary, () =>
		sql`INSERT INTO options (name, value) VALUES (${lastKey(backup.slug)}, ${JSON.stringify(backup.createdAt)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(controlDb()),
	);
	return { key, bytes: body.length };
}

export const backupSite = async (slug: string, tag?: string) => saveBackup(await exportSite(slug), tag);

/** Backup keys of a site, oldest first. */
export async function listBackups(slug: string): Promise<string[]> {
	const { bucket } = await needs();
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix: backupPrefix(slug), cursor, limit: 1000 });
		keys.push(...page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return keys.sort();
}

/** When each site was last backed up (ISO), by slug. */
export async function readLastBackups(): Promise<Map<string, string>> {
	const r = await runAsSite(scopeState().primary, () =>
		sql<{ name: string; value: string }>`SELECT name, value FROM options WHERE name LIKE 'multisite:backup:%'`.execute(controlDb()),
	);
	return new Map(r.rows.map((x) => [x.name.slice("multisite:backup:".length), JSON.parse(x.value) as string]));
}

export type RestoreResult = "restored" | "not-found" | "site-has-tables" | "bad-backup";

/**
 * Put a site back from a backup. Without `replace` the site must have no tables. With it the
 * current state is backed up first (`-pre-restore`), then the tables are dropped and rebuilt, so a
 * bad restore can itself be undone.
 */
export async function restoreSite(slug: string, key: string, opts: { replace: boolean }): Promise<RestoreResult> {
	const { db, bucket } = await needs();
	// Only this site's own backup files: the key comes from a request.
	if (!key.startsWith(backupPrefix(slug)) || key.includes("..")) return "not-found";
	const object = await bucket.get(key);
	if (!object) return "not-found";
	let backup: Backup;
	try {
		backup = JSON.parse(await object.text()) as Backup;
	} catch {
		return "bad-backup";
	}
	if (backup.version !== 1 || backup.slug !== slug || ![backup.schema, backup.data, backup.triggers].every(Array.isArray)) return "bad-backup";
	if (await siteHasTables(slug)) {
		if (!opts.replace) return "site-has-tables";
		await backupSite(slug, "pre-restore");
		const dropped = await runAsSite(scopeState().primary, () => dropSiteTables(slug));
		if (dropped.remaining) throw new Error(`[multisite] could not clear ${dropped.remaining} tables of "${slug}"; nothing restored`);
	}
	const statements = ["PRAGMA defer_foreign_keys = ON", ...backup.schema, ...backup.data, ...backup.triggers].map((s) => retarget(s, backup.slug, slug));
	await db.batch(statements.map((s) => db.prepare(s)));
	forgetSiteTheme(slug);
	return "restored";
}
