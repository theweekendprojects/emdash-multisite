/**
 * Cache tripwire: run with `node --no-warnings scripts/caches.selfcheck.ts [path-to-emdash-package]`.
 *
 * Scans every JS/TS file in the installed `emdash` package and asserts that
 *   1. every `Symbol.for("emdash:...")` cache key is classified (patched or site-independent);
 *   2. every patched cache's declaration still matches its rule, in each file that has it;
 *   3. every HOLDER/SLOT key is actually found (a stale rule would otherwise pass silently).
 * Fails with a precise message when an EmDash upgrade adds or reshapes a cache.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOLDER_KEYS, SLOT_KEYS, SITE_INDEPENDENT_KEYS, keysIn, patchCaches } from "../src/vite.ts";

const root = process.argv[2] ?? new URL("../node_modules/emdash", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "tests", "test", "__tests__", "locales", "docs"]);

function* walk(dir: string): Generator<string> {
	for (const name of readdirSync(dir)) {
		if (SKIP.has(name)) continue;
		const p = join(dir, name);
		const st = statSync(p);
		if (st.isDirectory()) yield* walk(p);
		else if (/\.(mjs|js|ts)$/.test(name) && !name.endsWith(".d.ts") && !name.endsWith(".d.mts")) yield p;
	}
}

let failed = 0;
const fail = (m: string) => {
	failed++;
	console.log(`FAIL  ${m}`);
};

const seen = new Map<string, number>();
let filesWithKeys = 0;
for (const file of walk(root)) {
	const code = readFileSync(file, "utf8");
	if (!code.includes("Symbol.for(")) continue;
	const keys = keysIn(code);
	if (keys.length === 0) continue;
	filesWithKeys++;
	for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
	let patched: string | null = null;
	try {
		patched = patchCaches(code, file);
	} catch (e) {
		fail(file.replace(root, "emdash") + "\n      " + (e as Error).message.slice(0, 260));
		continue;
	}
	if (patched === null) continue;
	// The patch must land on the declaration that USES the key, not just any
	// lookalike (an alias like `holder` is reused by unrelated functions).
	const lines = patched.split("\n");
	for (const key of keys.filter((k) => (SLOT_KEYS as readonly string[]).includes(k))) {
		const consts = [...patched.matchAll(new RegExp(`(\\w+) = Symbol\\.for\\("${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`, "g"))].map((m) => m[1]!);
		for (const c of consts) {
			for (const use of patched.matchAll(new RegExp(`(\\w+)\\[${c}\\]`, "g"))) {
				const before = patched.slice(0, use.index!);
				const decl = [...before.matchAll(new RegExp(`(?:const|let) ${use[1]}(?::[^=\\n]+)? = ([^;\\n]+);`, "g"))].pop();
				if (!decl || !decl[1]!.startsWith("__siteGlobal(") || !decl[1]!.includes(JSON.stringify(key)))
					fail(`${file.replace(root, "emdash")}: "${key}" is read via ${use[1]}[...] but its nearest declaration is \`${decl?.[0]?.slice(0, 70)}\``);
			}
		}
	}
	for (const key of keys.filter((k) => (HOLDER_KEYS as readonly string[]).includes(k))) {
		if (!lines.some((l) => l.includes(`__siteScoped(${JSON.stringify(key)}`)))
			fail(`${file.replace(root, "emdash")}: holder "${key}" was not rewritten`);
	}
}

for (const k of [...HOLDER_KEYS, ...SLOT_KEYS]) {
	if (!seen.has(k)) fail(`rule for "${k}" matched no file in ${root} (stale rule, or core renamed/removed the cache)`);
}
const allKnown = new Set<string>([...HOLDER_KEYS, ...SLOT_KEYS, ...Object.keys(SITE_INDEPENDENT_KEYS)]);
for (const k of seen.keys()) if (!allKnown.has(k)) fail(`unclassified cache key "${k}"`);

console.log(
	`scanned ${root.split("/node_modules/").pop()}: ${filesWithKeys} files with cache keys, ${seen.size} distinct keys ` +
		`(${HOLDER_KEYS.length} holder + ${SLOT_KEYS.length} slot patched, ${Object.keys(SITE_INDEPENDENT_KEYS).length} classified site-independent)`,
);
console.log(failed ? `\n${failed} FAILED` : "\nall caches classified and patchable");
process.exit(failed ? 1 : 0);
