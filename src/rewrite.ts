/**
 * Per-site table naming, applied to the FINAL compiled SQL.
 *
 * One site (the "primary") keeps its original, unprefixed table names, so an
 * existing single-site install is untouched. Every other site gets the same
 * schema under `<table>$<site>` inside the same database.
 *
 * Working on SQL text (not the Kysely AST) is deliberate: core's builder
 * queries, `sql.ref(tableName)` and its ~138 literal raw statements all reach
 * the driver as text, so one mechanism covers all of them. `$` is the marker
 * because a collection slug may legally contain `__` but never `$`.
 *
 * Known ceiling: rewriting is positional (table follows FROM/JOIN/INTO/...,
 * or is a `name.` qualifier). A comma-joined second table (`FROM a, b`) or an
 * alias that reuses a core table name is not rewritten; it fails loudly with
 * "no such table/column" rather than reading another site's data.
 */

// DNS-label shaped: lowercase letters, digits and inner hyphens, 1-40 chars.
const SITE_ID = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
export const isSiteId = (s: string): boolean => SITE_ID.test(s);

/** Core tables that do not follow the ec_/_emdash_/_plugin_ naming rule. */
const UNPREFIXED_CORE_TABLES = new Set([
	"allowed_domains",
	"audit_logs",
	"auth_challenges",
	"auth_tokens",
	"content_taxonomies",
	"credentials",
	"media",
	"media_folders",
	"oauth_accounts",
	"options",
	"revisions",
	"taxonomies",
	"users",
]);

/** Is this (unsuffixed) table name one that belongs to a single site? */
export function isSiteTable(name: string): boolean {
	const n = name.toLowerCase();
	if (n.includes("$") || n.startsWith("sqlite_") || n.startsWith("_cf_")) return false;
	if (/^(ec_|_emdash_|_plugin_)/.test(n)) return true;
	// migrations rebuild tables as <t>_new / <t>_old, then rename
	return UNPREFIXED_CORE_TABLES.has(n.replace(/_(new|old)$/, ""));
}

export const suffixFor = (site: string, primary: string): string =>
	site === primary ? "" : `$${site}`;

/** Quote a (possibly suffixed) identifier. */
const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;

const TOKEN =
	/\s+|'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|--[^\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|[\s\S]/gy;

/** Keywords after which the next identifier is a table name. */
const TABLE_CONTEXT = new Set(["FROM", "JOIN", "INTO", "UPDATE", "TABLE", "REFERENCES", "EXISTS", "TO"]);

const PRAGMA_TABLE_FN =
	/\b((?:pragma_)?(?:table_info|table_xinfo|index_list|foreign_key_list))(\s*\(\s*)(['"`]?)([A-Za-z_][A-Za-z0-9_]*)\3/gi;
const PRAGMA_INDEX_FN =
	/\b((?:pragma_)?(?:index_info|index_xinfo))(\s*\(\s*)(['"`]?)([A-Za-z_][A-Za-z0-9_]*)\3/gi;

function rewritePragmas(sql: string, suffix: string): string {
	const out = (name: string, quote: string) => (quote === "'" ? `'${name}'` : q(name));
	return sql
		.replace(PRAGMA_TABLE_FN, (m, fn: string, open: string, quote: string, name: string) =>
			isSiteTable(name) ? `${fn}${open}${out(name + suffix, quote)}` : m,
		)
		.replace(PRAGMA_INDEX_FN, (m, fn: string, open: string, quote: string, name: string) =>
			name.includes("$") ? m : `${fn}${open}${out(name + suffix, quote)}`,
		);
}

/** Rewrite every table/index/trigger identifier in `sql` for a non-primary site. */
export function rewriteSql(sql: string, suffix: string): string {
	if (!suffix) return sql;
	const head = /^\s*(?:CREATE|DROP)\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(INDEX|TRIGGER)\b/i.exec(sql);
	let objectNamePending = head !== null;
	// In CREATE TRIGGER the table follows ON (`AFTER INSERT ON t WHEN ...`); in
	// CREATE INDEX it follows ON too but is always followed by `(`.
	const isTrigger = head?.[1]?.toUpperCase() === "TRIGGER";
	const toks: string[] = [];
	for (const m of rewritePragmas(sql, suffix).matchAll(TOKEN)) toks.push(m[0]);

	const significant = (i: number, step: 1 | -1): string | undefined => {
		for (let j = i + step; j >= 0 && j < toks.length; j += step) {
			const t = toks[j]!;
			if (!/^\s+$/.test(t) && !t.startsWith("--") && !t.startsWith("/*")) return t;
		}
		return undefined;
	};

	for (let i = 0; i < toks.length; i++) {
		const tok = toks[i]!;
		const quoted = tok[0] === '"' || tok[0] === "`";
		const isWord = /^[A-Za-z_]/.test(tok);
		if (!quoted && !isWord) continue;
		const name = quoted ? tok.slice(1, -1).replaceAll('""', '"') : tok;
		const prev = significant(i, -1);
		const next = significant(i, 1);

		// CREATE/DROP INDEX|TRIGGER [IF [NOT] EXISTS] <name>: names are global in SQLite.
		if (objectNamePending && !quoted && /^(INDEX|TRIGGER|UNIQUE|IF|NOT|EXISTS|CREATE|DROP)$/i.test(tok)) continue;
		if (objectNamePending) {
			objectNamePending = false;
			if (!name.includes("$")) toks[i] = q(name + suffix);
			continue;
		}

		if (!isSiteTable(name)) continue;
		const upPrev = prev && /^[A-Za-z_]+$/.test(prev) ? prev.toUpperCase() : "";
		const inTableSlot =
			(upPrev !== "" && TABLE_CONTEXT.has(upPrev)) ||
			(upPrev === "ON" && (next === "(" || (isTrigger && next !== "."))) ||
			(next === "." && prev !== ".");
		if (inTableSlot) toks[i] = q(name + suffix);
	}
	return toks.join("");
}

const INTROSPECTION = /sqlite_(?:master|schema)|\bpragma\b|pragma_/i;
const INDEX_PRAGMA = /index_info|index_xinfo/i;
const TYPE_WORDS = new Set(["table", "index", "view", "trigger"]);

export const isIntrospection = (sql: string): boolean => INTROSPECTION.test(sql);

/** Bound parameters that are object names in an introspection query get the suffix too. */
export function rewriteParams(sql: string, params: readonly unknown[], suffix: string): readonly unknown[] {
	if (!suffix || !isIntrospection(sql)) return params;
	const anyName = /sqlite_(?:master|schema)/i.test(sql) || INDEX_PRAGMA.test(sql);
	return params.map((p) => {
		if (typeof p !== "string" || p.includes("$") || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) return p;
		if (TYPE_WORDS.has(p.toLowerCase())) return p;
		return anyName || isSiteTable(p) ? p + suffix : p;
	});
}

type Row = Record<string, unknown>;
const NAME_KEYS = ["name", "tbl_name", "table"] as const;

/** Make an introspection result look like this site's own unprefixed database. */
export function translateRows<R>(sql: string, rows: R[], suffix: string): R[] {
	if (!isIntrospection(sql)) return rows;
	const listsSchema = /sqlite_(?:master|schema)/i.test(sql);
	const out: R[] = [];
	for (const raw of rows) {
		const row = raw as unknown as Row;
		const name = row["name"];
		if (listsSchema && typeof name === "string") {
			const mine = suffix ? name.endsWith(suffix) : !name.includes("$");
			if (!mine) continue;
		}
		if (!suffix) {
			out.push(raw);
			continue;
		}
		const copy: Row = { ...row };
		for (const k of NAME_KEYS) {
			const v = copy[k];
			if (typeof v === "string" && v.endsWith(suffix)) copy[k] = v.slice(0, -suffix.length);
		}
		if (typeof copy["sql"] === "string") {
			copy["sql"] = copy["sql"].replaceAll(new RegExp(`${suffix.replace("$", "\\$")}(?![A-Za-z0-9_$-])`, "g"), "");
		}
		out.push(copy as unknown as R);
	}
	return out;
}
