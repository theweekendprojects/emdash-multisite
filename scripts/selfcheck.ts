/**
 * Runnable self-check (no framework): `npm run selfcheck`.
 *
 * Part 1 is the oracle: it runs core's REAL migrations through the wrapped
 * dialect as two non-primary sites plus the primary, and asserts the result.
 * That is the evidence the text rewrite survives everything core's DDL does
 * (table rebuilds, renames, FKs, indexes, triggers, introspection).
 * Part 2 pins rewrite edge cases that migrations alone don't exercise.
 */
import { DatabaseSync } from "node:sqlite";
import { Kysely, sql } from "kysely";
import { runMigrations } from "emdash/db";
import { SchemaRegistry, ContentRepository } from "emdash";
import { createDialect } from "emdash/db/sqlite";
import { siteDialect, runAsSite, currentSite } from "../src/dialect.ts";
import { makeRuntime } from "../src/runtime.ts";
import { isSiteTable, rewriteSql } from "../src/rewrite.ts";
import { resolveSite } from "../src/sites.ts";
import { rmSync } from "node:fs";

let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ---------- Part 2 first: pure rewrite edge cases ----------
const S = "$acme";
eq("builder select", rewriteSql('select "id" from "ec_posts" where "slug" = ?', S), 'select "id" from "ec_posts$acme" where "slug" = ?');
eq("qualifier + join", rewriteSql("SELECT ec_posts.id FROM ec_posts JOIN users ON users.id = ec_posts.author_id", S), 'SELECT "ec_posts$acme".id FROM "ec_posts$acme" JOIN "users$acme" ON "users$acme".id = "ec_posts$acme".author_id');
eq("alias is not renamed", rewriteSql('select a.slug from "ec_posts" as a join "ec_posts" b on a.id = b.id', S), 'select a.slug from "ec_posts$acme" as a join "ec_posts$acme" b on a.id = b.id');
eq("column named like a table untouched", rewriteSql("SELECT media, options FROM ec_posts", S), 'SELECT media, options FROM "ec_posts$acme"');
eq("string literal untouched", rewriteSql("SELECT 'FROM users' AS x FROM ec_posts", S), `SELECT 'FROM users' AS x FROM "ec_posts$acme"`);
eq("create index renames index + table", rewriteSql('create unique index "idx_a" on "ec_posts" ("slug")', S), 'create unique index "idx_a$acme" on "ec_posts$acme" ("slug")');
eq("trigger name", rewriteSql("CREATE TRIGGER IF NOT EXISTS t1 AFTER INSERT ON options BEGIN SELECT 1; END", S), 'CREATE TRIGGER IF NOT EXISTS "t1$acme" AFTER INSERT ON "options$acme" BEGIN SELECT 1; END');
eq("rename-to target", rewriteSql('alter table "users_new" rename to "users"', S), 'alter table "users_new$acme" rename to "users$acme"');
eq(
	"fts5 hidden column, bm25 and snippet follow the table",
	rewriteSql(`SELECT snippet("_emdash_fts_posts", 2, '<mark>', '</mark>', '...', 32) AS s, bm25("_emdash_fts_posts") AS score FROM "_emdash_fts_posts" f JOIN "ec_posts" c ON f.id = c.id WHERE "_emdash_fts_posts" MATCH ? ORDER BY score`, S),
	`SELECT snippet("_emdash_fts_posts$acme", 2, '<mark>', '</mark>', '...', 32) AS s, bm25("_emdash_fts_posts$acme") AS score FROM "_emdash_fts_posts$acme" f JOIN "ec_posts$acme" c ON f.id = c.id WHERE "_emdash_fts_posts$acme" MATCH ? ORDER BY score`,
);
eq("a column that only looks like a table is left alone", rewriteSql("SELECT users FROM ec_posts WHERE x = 1", S), 'SELECT users FROM "ec_posts$acme" WHERE x = 1');
eq("pragma table fn", rewriteSql("SELECT name FROM pragma_table_info('ec_posts')", S), `SELECT name FROM pragma_table_info('ec_posts$acme')`);
eq("primary is identity", rewriteSql("SELECT * FROM ec_posts", ""), "SELECT * FROM ec_posts");
eq("sqlite_ internals shared", isSiteTable("sqlite_sequence"), false);
eq("host: wildcard", resolveSite("acme.example.com", { primary: "main", wildcard: "example.com" }), "acme");
eq("host: unknown -> primary", resolveSite("localhost:4321", { primary: "main", wildcard: "example.com" }), "main");
eq("host: custom domain", resolveSite("blog.acme.io", { primary: "main", hosts: { "blog.acme.io": "acme" } }), "acme");

// ---------- Part 1: real migrations through the wrapper ----------
const FILE = "/tmp/emdash-multisite-selfcheck.db";
for (const s of ["", "-wal", "-shm"]) rmSync(FILE + s, { force: true });
const inner = createDialect({ url: `file:${FILE}` });
const wrapped = new Kysely<never>({ dialect: siteDialect(inner, () => currentSite() ?? "main", "main") });

const migrate = (site: string) => runAsSite(site, () => runMigrations(wrapped as never));
const a = await migrate("main");
const b = await migrate("acme");
const c = await migrate("globex");
const d = await migrate("acme-co"); // hyphenated, and "acme" is a prefix of it
eq("every site applies the same, non-zero migration set", a.applied.length > 0 && a.applied.length === b.applied.length && b.applied.length === c.applied.length && c.applied.length === d.applied.length, true);
eq("re-running migrations is a no-op (introspection translation works)", (await migrate("acme")).applied.length, 0);

const raw = new DatabaseSync(FILE);
type Obj = { type: string; name: string; sql: string | null };
const objs = (raw.prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%'").all() as Obj[]);
const ofSite = (suffix: string) => objs.filter((o) => (suffix ? o.name.endsWith(suffix) : !o.name.includes("$")));
const count = (list: Obj[], t: string) => list.filter((o) => o.type === t).length;
const primary = ofSite("");
eq("primary has tables, indexes and triggers", [count(primary, "table") > 0, count(primary, "index") > 0, count(primary, "trigger") > 0], [true, true, true]);

// Upgrade tripwire: a core table the naming rule misses would be SHARED across sites.
eq("every core table is covered by isSiteTable (else it leaks across sites)", primary.filter((o) => o.type === "table" && !isSiteTable(o.name)).map((o) => o.name), []);

// The strong invariant: each site's whole schema is identical to the primary's
// modulo the suffix (and identifier quoting, which the rewrite adds).
const norm = (sql: string | null, suffix: string) => (sql ?? "").replaceAll(suffix, "").replaceAll('"', "").replace(/\s+/g, " ").trim();
for (const site of ["acme", "globex", "acme-co"]) {
	const suffix = `$${site}`;
	const mine = ofSite(suffix);
	const sameNames = JSON.stringify(mine.map((o) => `${o.type}:${o.name.replace(suffix, "")}`).sort()) === JSON.stringify(primary.map((o) => `${o.type}:${o.name}`).sort());
	eq(`${site}: same objects as primary (tables/indexes/triggers)`, sameNames, true);
	const byName = new Map(primary.map((o) => [o.name, o]));
	const differing = mine.filter((o) => norm(o.sql, suffix) !== norm(byName.get(o.name.replace(suffix, ""))?.sql ?? null, ""));
	eq(`${site}: every stored statement identical to primary's modulo suffix`, differing.map((o) => o.name), []);
}

// The invariant above is blind to a name that was never rewritten (it would
// still equal the primary's text), so also assert directly: no non-primary
// statement mentions a bare core-table name outside string literals.
const coreTables = new Set(primary.filter((o) => o.type === "table").map((o) => o.name));
// Only table-reference positions count: a column may legitimately be named
// like a table (`"options" text` in _emdash_fields).
const bareRefs = (sqlText: string) =>
	[...sqlText.replace(/'(?:[^']|'')*'/g, "''").matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|REFERENCES|EXISTS|TO|ON)\s+"?([A-Za-z_][A-Za-z0-9_$]*)"?|"?([A-Za-z_][A-Za-z0-9_$]*)"?\s*\./gi)]
		.map((m) => m[1] ?? m[2] ?? "")
		.filter((id) => coreTables.has(id));
for (const site of ["acme", "globex", "acme-co"]) {
	const bare = ofSite(`$${site}`).flatMap((o) => bareRefs(o.sql ?? "").map((id) => `${o.name}: ${id}`));
	eq(`${site}: no stored statement references a bare (unsuffixed) core table`, bare, []);
}

// FKs stay inside the site.
const crossSite: string[] = [];
for (const o of ofSite("$acme").filter((o) => o.type === "table")) {
	for (const fk of raw.prepare(`PRAGMA foreign_key_list("${o.name}")`).all() as { table: string }[]) {
		if (!fk.table.endsWith("$acme")) crossSite.push(`${o.name} -> ${fk.table}`);
	}
}
eq("no acme table has an FK into another site", crossSite, []);

// Triggers fire on their OWN site's table (this caught a real leak: ON <table> was not rewritten).
const optionRow = (site: string) => runAsSite(site, async () => (await sql<{ revision: string }>`SELECT revision FROM options WHERE name = ${"probe"}`.execute(wrapped)).rows[0]?.revision);
await runAsSite("acme", () => sql`INSERT INTO options (name, value) VALUES (${"probe"}, ${"1"})`.execute(wrapped));
const rev = await optionRow("acme");
eq("acme's options trigger fired on acme's table (revision stamped)", rev !== undefined && rev !== "0", true);
eq("...and did not touch main/globex", [await optionRow("main"), await optionRow("globex")], [undefined, undefined]);
await runAsSite("acme", () => sql`DELETE FROM options WHERE name = ${"probe"}`.execute(wrapped));

// data isolation through the real Kysely path
const ins = (site: string, id: string, k: string) => runAsSite(site, () => wrapped.insertInto("options" as never).values({ name: k, value: JSON.stringify(id) } as never).execute());
await ins("main", "m", "site.title");
await ins("acme", "a", "site.title");
const read = (site: string) => runAsSite(site, async () => (await sql<{ value: string }>`SELECT value FROM options WHERE name = ${"site.title"}`.execute(wrapped)).rows.map((r) => r.value));
eq("options isolated per site (raw sql path)", [await read("main"), await read("acme"), await read("globex")], [['"m"'], ['"a"'], []]);

// "acme" is a string prefix of "acme-co": their tables, and what introspection reports for each,
// must never mix.
await ins("acme-co", "co", "site.title");
eq("prefix-sibling sites stay separate", [await read("acme"), await read("acme-co")], [['"a"'], ['"co"']]);
const tablesAsSeenBy = (site: string) =>
	runAsSite(site, async () => (await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"options"}`.execute(wrapped)).rows.length);
eq("introspection (tableExists-style) sees only its own site's table", [await tablesAsSeenBy("acme"), await tablesAsSeenBy("acme-co"), await tablesAsSeenBy("globex")], [1, 1, 1]);

// per-request path: host decides the site, handle is cached per site
const rt = makeRuntime(() => inner);
const cfg = { inner: {}, sites: { primary: "main", wildcard: "example.com" } };
const reqAcme = rt.createRequestScopedDb({ config: cfg, url: new URL("https://acme.example.com/") });
const reqAcme2 = rt.createRequestScopedDb({ config: cfg, url: new URL("https://acme.example.com/x") });
const reqMain = rt.createRequestScopedDb({ config: cfg, url: new URL("http://localhost:4321/") });
eq("per-site Kysely is cached", reqAcme.db === reqAcme2.db, true);
const titleVia = async (h: { db: Kysely<unknown> }) => (await sql<{ value: string }>`SELECT value FROM options WHERE name = ${"site.title"}`.execute(h.db)).rows.map((r) => r.value);
eq("request scoped db reads its own site", [await titleVia(reqAcme), await titleVia(reqMain)], [['"a"'], ['"m"']]);

// ---------- Part 3: core's own repositories (runs their raw SQL) ----------
const core = new Kysely<any>({ dialect: siteDialect(inner, () => currentSite() ?? "main", "main") });
for (const site of ["main", "acme"]) {
	await runAsSite(site, async () => {
		await new SchemaRegistry(core).createCollection({ slug: "posts", label: "Posts", supports: ["drafts"] } as never);
		await new SchemaRegistry(core).createField("posts", { slug: "title", label: "Title", type: "string" } as never);
		await new ContentRepository(core).create({ type: "posts", slug: `${site}-hello`, data: { title: site }, status: "published" } as never);
	});
}
const slugsOf = (site: string) => runAsSite(site, async () => (await new ContentRepository(core).findMany("posts", {} as never)).items.map((i: any) => i.slug));
eq("ContentRepository.findMany is per-site", [await slugsOf("main"), await slugsOf("acme")], [["main-hello"], ["acme-hello"]]);
eq("findBySlug cannot see another site's row", await runAsSite("acme", async () => (await new ContentRepository(core).findBySlug("posts", "main-hello")) ?? null), null);
eq("collection missing on a site fails loudly (no fallback to another site)", await slugsOf("globex").then(() => "returned", (e: Error) => /no such table/.test(e.message)), true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
raw.close();
await wrapped.destroy();
await core.destroy();
for (const s of ["", "-wal", "-shm"]) rmSync(FILE + s, { force: true });
process.exit(failed ? 1 : 0);
