#!/usr/bin/env node
// emdash-multisite setup — scaffold the multi-tenant wiring into an existing
// EmDash + Cloudflare Astro app.
//
// Usage (from your EmDash app root):
//   npx emdash-multisite setup [--force] [--dir .]
//
// What it does (idempotent, non-destructive by default):
//   1. Writes src/worker.ts           (host-aware edge cache; the one per-project file)
//   2. Writes wrangler.multisite.jsonc (the keys to merge into your wrangler.jsonc)
//   3. Writes astro.config.multisite.mjs (the config to merge into your astro.config)
//   4. Prints the exact next steps (merge the two snippets, bootstrap the admin)
//
// It NEVER overwrites an existing file unless --force. Snippets for files it
// won't auto-merge (wrangler.jsonc, astro.config.mjs) are written next to them
// with a `.multisite.` marker so you can diff + merge by hand — merging JSONC
// and arbitrary astro config safely by machine is not worth the risk.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args[0] === "setup") args.shift(); // allow both `emdash-multisite setup` and bare
const force = args.includes("--force");
const dirFlag = args.indexOf("--dir");
const root = resolve(dirFlag >= 0 ? args[dirFlag + 1] : ".");
const templates = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");

const C = { gray: "\x1b[90m", green: "\x1b[32m", yellow: "\x1b[33m", bold: "\x1b[1m", reset: "\x1b[0m" };
const log = (s = "") => process.stdout.write(`${s}\n`);
const ok = (s) => log(`  ${C.green}✓${C.reset} ${s}`);
const skip = (s) => log(`  ${C.yellow}•${C.reset} ${s}`);

function sanityCheck() {
	const pkgPath = join(root, "package.json");
	if (!existsSync(pkgPath)) {
		log(`${C.yellow}No package.json in ${root}. Run this from your EmDash app root (or pass --dir).${C.reset}`);
		process.exit(1);
	}
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	if (!deps.emdash) {
		log(`${C.yellow}Warning: "emdash" is not a dependency here. This scaffolder is for an existing EmDash app.${C.reset}`);
	}
	return { pkgPath, pkg, deps };
}

function copy(fromName, toRel, { marker = false } = {}) {
	const to = join(root, toRel);
	const src = join(templates, fromName);
	if (!existsSync(src)) {
		skip(`template ${fromName} missing in package — skipped`);
		return;
	}
	if (existsSync(to) && !force) {
		skip(`${toRel} exists — left as is ${C.gray}(--force to overwrite)${C.reset}`);
		return;
	}
	mkdirSync(dirname(to), { recursive: true });
	writeFileSync(to, readFileSync(src, "utf8"));
	ok(`${marker ? "wrote snippet " : "wrote "}${toRel}`);
}

log(`\n${C.bold}emdash-multisite setup${C.reset} ${C.gray}(${root})${C.reset}\n`);
const { deps } = sanityCheck();

// 1. the one real per-project file
copy("worker.ts", "src/worker.ts");

// 2 + 3. snippets to merge (never auto-edit the user's config/wrangler)
copy("wrangler.snippet.jsonc", "wrangler.multisite.jsonc", { marker: true });
copy("astro.config.snippet.mjs", "astro.config.multisite.mjs", { marker: true });

log(`\n${C.bold}Next steps${C.reset}`);
if (!deps["emdash-multisite"]) {
	log(`  1. Install the package:   ${C.bold}pnpm add emdash-multisite${C.reset}`);
}
log(`  ${deps["emdash-multisite"] ? "1" : "2"}. Merge ${C.bold}astro.config.multisite.mjs${C.reset} into your astro.config.mjs (3 wires: database, vite plugin, middleware).`);
log(`  ${deps["emdash-multisite"] ? "2" : "3"}. Merge ${C.bold}wrangler.multisite.jsonc${C.reset} into your wrangler.jsonc (main + cache + exports).`);
log(`  ${deps["emdash-multisite"] ? "3" : "4"}. Bootstrap the control-plane admin once (see README "First admin"): ${C.gray}bootstrapControlPlane(db, "you@example.com")${C.reset}`);
log(`  ${deps["emdash-multisite"] ? "4" : "5"}. Verify: ${C.gray}node --no-warnings node_modules/emdash-multisite/scripts/caches.selfcheck.ts ./node_modules${C.reset}`);
log(`\nFull guide: ${C.bold}SETUP.md${C.reset} · Reference & gotchas: ${C.bold}README.md${C.reset}\n`);
