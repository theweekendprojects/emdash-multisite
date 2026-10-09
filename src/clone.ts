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
	/** The tables (and virtual tables) that hold data, by their current names. Used to export rows. */
	tables: string[];
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
		tables: [...plain, ...virtual].map((r) => r.name),
		triggers: own.filter((r) => r.type === "trigger").map((r) => swap(r.sql!)),
	};
}

/**
 * Multi-row INSERTs for an export. `tuples` are already SQL literals, e.g. `('a',1,NULL)`
 * (made by SQLite's `quote()`, so text, numbers, NULL and blobs all round-trip).
 * Grouped so a big table is a few statements, each under `maxBytes`.
 */
export function insertStatements(table: string, columns: string[], tuples: string[], maxRows = 100, maxBytes = 60_000): string[] {
	const head = `INSERT INTO ${quote(table)} (${columns.map(quote).join(", ")}) VALUES `;
	const out: string[] = [];
	let batch: string[] = [];
	let size = head.length;
	const flush = () => {
		if (batch.length) out.push(head + batch.join(", "));
		batch = [];
		size = head.length;
	};
	for (const t of tuples) {
		if (batch.length >= maxRows || (batch.length && size + t.length > maxBytes)) flush();
		batch.push(t);
		size += t.length + 2;
	}
	flush();
	return out;
}

/**
 * Restore a statement under another site id. Schema statements swap the `$<site>` suffix
 * everywhere; an INSERT swaps it only in the table name, never in the row values.
 */
export function retarget(statement: string, from: string, to: string): string {
	if (from === to) return statement;
	const insert = /^(INSERT INTO ")([^"]+)(")/.exec(statement);
	if (!insert) return statement.replaceAll(`$${from}`, `$${to}`);
	return insert[1] + insert[2]!.replaceAll(`$${from}`, `$${to}`) + insert[3] + statement.slice(insert[0].length);
}
