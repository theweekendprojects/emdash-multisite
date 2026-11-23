/**
 * Media-usage activation must finish for a non-primary site. It compares each capture trigger's
 * stored DDL with the DDL it would generate, so the suffix rewrite has to round-trip exactly.
 * (Without that, every tenant stayed `activating` and core's write fence answered 503.)
 * Reaches into the host's installed emdash build: that module is not a public export.
 */
import { Kysely } from "kysely";
import { runMigrations } from "emdash/db";
import { SchemaRegistry } from "emdash";
import { createDialect } from "emdash/db/sqlite";
import { siteDialect, runAsSite, currentSite } from "../src/dialect.ts";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// The dist file name carries a content hash that changes every emdash release, so find the chunk that
// exports activateMediaUsageCapture (exported under the minified name `r`) in the installed emdash.
const DIST = fileURLToPath(new URL("../node_modules/emdash/dist/", import.meta.url));
const chunk = readdirSync(DIST).find((f) => /^activation-[^.]*\.mjs$/.test(f) && readFileSync(DIST + f, "utf8").includes("activateMediaUsageCapture as r"));
if (!chunk) throw new Error("activateMediaUsageCapture chunk not found in emdash/dist; core changed");
const { r: activateMediaUsageCapture } = (await import(DIST + chunk)) as { r: (db: unknown, opts: { writersDrained: boolean }) => Promise<{ outcome: string }> };
const FILE = "/tmp/emdash-multisite-activation.db";
for (const s of ["", "-wal", "-shm"]) rmSync(FILE + s, { force: true });
const db = new Kysely<any>({ dialect: siteDialect(createDialect({ url: `file:${FILE}` }), () => currentSite() ?? "main", "main") });
await runAsSite("main", () => runMigrations(db as never));
await runAsSite("acme-co", async () => {
	await runMigrations(db as never);
	const reg = new SchemaRegistry(db as never);
	for (const slug of ["posts", "pages"]) await reg.createCollection({ slug, label: slug, supports: ["search"] } as never);
	await db.updateTable("_emdash_media_usage_activation").set({ state: "expanded" }).execute();
	let outcome = "";
	for (let i = 0; i < 4 && outcome !== "active"; i++) outcome = (await activateMediaUsageCapture(db as never, { writersDrained: true })).outcome;
	assert.equal(outcome, "active");
});
console.log("PASS  media-usage activation completes on a suffixed site");
for (const s of ["", "-wal", "-shm"]) rmSync(FILE + s, { force: true });
await db.destroy();
