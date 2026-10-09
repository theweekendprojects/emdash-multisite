import { clonePlan, insertStatements, retarget, type MasterRow } from "../src/clone.ts";
let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`}`);
};
const rows: MasterRow[] = [
	{ type: "table", name: "posts$tpl", sql: 'CREATE TABLE "posts$tpl" (id TEXT PRIMARY KEY, owner TEXT REFERENCES "users$tpl"(id))' },
	{ type: "table", name: "users$tpl", sql: 'CREATE TABLE "users$tpl" (id TEXT PRIMARY KEY)' },
	{ type: "index", name: "sqlite_autoindex_posts$tpl_1", sql: null },
	{ type: "index", name: "idx_posts$tpl", sql: 'CREATE INDEX "idx_posts$tpl" ON "posts$tpl"(owner)' },
	{ type: "table", name: "fts$tpl", sql: 'CREATE VIRTUAL TABLE "fts$tpl" USING fts5(title)' },
	{ type: "table", name: "fts$tpl_data", sql: 'CREATE TABLE \'fts$tpl_data\'(id INTEGER PRIMARY KEY, block BLOB)' },
	{ type: "table", name: "fts$tpl_config", sql: "CREATE TABLE 'fts$tpl_config'(k PRIMARY KEY, v) WITHOUT ROWID" },
	{ type: "trigger", name: "t$tpl", sql: 'CREATE TRIGGER "t$tpl" AFTER INSERT ON "posts$tpl" BEGIN SELECT 1; END' },
	{ type: "table", name: "posts$other", sql: 'CREATE TABLE "posts$other" (id TEXT)' },
	{ type: "table", name: "posts$tpl2", sql: 'CREATE TABLE "posts$tpl2" (id TEXT)' },
	{ type: "table", name: "options", sql: "CREATE TABLE options (name TEXT)" },
];
const p = clonePlan(rows, "tpl", "acme");
check("tables first, then virtual, then indexes, suffix swapped", p.schema.map((s) => s.split("(")[0].replace(/^CREATE (VIRTUAL )?(TABLE|INDEX) /, "").replace(/ USING fts5| ON .*/, "")), ['"posts$acme" ', '"users$acme" ', '"fts$acme"', '"idx_posts$acme"']);
check("foreign key follows the swap", p.schema[0].includes('REFERENCES "users$acme"'), true);
check("fts shadow tables and autoindexes are not replayed", p.schema.some((s) => /_data|_config|autoindex/.test(s)), false);
check("other sites and unprefixed tables are untouched", p.schema.some((s) => /other|options|tpl2/.test(s)), false);
check("copy is INSERT ... SELECT per table", p.copy, [
	'INSERT INTO "posts$acme" SELECT * FROM "posts$tpl"',
	'INSERT INTO "users$acme" SELECT * FROM "users$tpl"',
	'INSERT INTO "fts$acme" SELECT * FROM "fts$tpl"',
]);
check("triggers come last and are swapped", p.triggers, ['CREATE TRIGGER "t$acme" AFTER INSERT ON "posts$acme" BEGIN SELECT 1; END']);
check("tables to export", p.tables, ["posts$tpl", "users$tpl", "fts$tpl"]);
check("insert statements: grouped by rows", insertStatements("t$x", ["a", "b"], ["(1,'x')", "(2,'y')", "(3,'z')"], 2), ['INSERT INTO "t$x" ("a", "b") VALUES (1,\'x\'), (2,\'y\')', 'INSERT INTO "t$x" ("a", "b") VALUES (3,\'z\')']);
check("insert statements: grouped by size, none lost", insertStatements("t", ["a"], ["(1)", "(2)", "(3)"], 100, 40).length > 1 && insertStatements("t", ["a"], ["(1)", "(2)", "(3)"], 100, 40).join(",").match(/\(\d\)/g)?.length === 3, true);
check("insert statements: no rows, no statements", insertStatements("t", ["a"], []), []);
check("retarget: schema swaps everywhere", retarget('CREATE INDEX "i$a" ON "t$a"(x)', "a", "b"), 'CREATE INDEX "i$b" ON "t$b"(x)');
check("retarget: insert swaps only the table name", retarget('INSERT INTO "t$a" ("c") VALUES (\'costs $a\')', "a", "b"), 'INSERT INTO "t$b" ("c") VALUES (\'costs $a\')');
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
