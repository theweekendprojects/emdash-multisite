/**
 * Pure: turn the schema of one site into the statements that rebuild it, with
 * its data, under another site id. No database access, so a plain-Node
 * self-check covers it (scripts/clone.selfcheck.ts).
 *
 * Input is a site's `sqlite_master` rows. Table names carry the site as a
 * `$<site>` suffix, so cloning is a text swap of that suffix.
 */
export interface MasterRow {
	type: string;
	name: string;
	sql: string | null;
}

export interface ClonePlan {
	/** Tables, virtual tables and indexes. Run first. */
	schema: string[];
	/** One `INSERT ... SELECT` per table; the rows never leave D1. */
	copy: string[];
	/** Triggers. Created after the copy so they do not fire on the copied rows. */
	triggers: string[];
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

export function clonePlan(rows: MasterRow[], from: string, to: string): ClonePlan {
	const swap = (s: string) => s.replaceAll(`$${from}`, `$${to}`);
	const own = rows.filter((r) => r.sql && !r.name.startsWith("sqlite_") && r.name.endsWith(`$${from}`));
	const virtual = own.filter((r) => r.type === "table" && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql!));
	// An FTS table's shadow tables (`<name>_data`, `_idx`, ...) do not end in `$<site>`, so
	// `own` already leaves them out: CREATE VIRTUAL TABLE makes them itself.
	const plain = own.filter((r) => r.type === "table" && !virtual.includes(r));
	const copyOf = (r: MasterRow) => `INSERT INTO ${quote(swap(r.name))} SELECT * FROM ${quote(r.name)}`;
	return {
		schema: [...plain, ...virtual, ...own.filter((r) => r.type === "index")].map((r) => swap(r.sql!)),
		copy: [...plain, ...virtual].map(copyOf),
		triggers: own.filter((r) => r.type === "trigger").map((r) => swap(r.sql!)),
	};
}
