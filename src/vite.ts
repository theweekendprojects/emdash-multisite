import { fileURLToPath } from "node:url";

/**
 * Build-time patch: make core's process-wide caches per-site.
 *
 * Core captures each cache as ONE object when its module loads, so the wrapper
 * cannot swap it per request. This plugin rewrites those declarations in core's
 * published code to `siteScoped(key, init)` (see scope.ts), a Proxy holding one
 * real object per site.
 *
 * Fail-closed: if a module mentions a cache key but its declaration no longer
 * matches the expected shape (core changed), the build errors instead of
 * shipping an unpatched, leaking cache.
 */

interface Rule {
	/** `Symbol.for(...)` key core uses for the slot. */
	key: string;
	/** `const <name> = g[<KEY_CONST>] ?? (() => { ...create + store... })();` */
	pattern: RegExp;
}

// Two shapes of the same declaration:
//   dist: const c = g[KEY] ?? (() => { ... })();
//   src : const c: Type =\n // comment\n (g[KEY] as Type | undefined) ??\n (() => { ... })();
// The optional parts are limited to a type annotation, `//` comment lines and a cast.
const SLOT_DECLARATION =
	/const (\w+)(?::[^=\n]+)? =\s*(?:\/\/[^\n]*\n\s*)*\(?g\[(\w+)\](?: as [^)]+)?\)? \?\?\s*(\(\(\) => \{[\s\S]*?\n\s*\}\)\(\));/;

export const RULES: readonly Rule[] = [{ key: "emdash:site-settings", pattern: SLOT_DECLARATION }];

const VIRTUAL = "virtual:emdash-multisite/scope";
const RESOLVED = `\0${VIRTUAL}`;
const SCOPE_FILE = fileURLToPath(new URL("./scope.ts", import.meta.url));

/** Rewrite one module's source. Returns null when it holds none of the cache keys. */
export function patchCaches(code: string, id: string): string | null {
	let out = code;
	let patched = false;
	for (const rule of RULES) {
		if (!out.includes(`Symbol.for("${rule.key}")`)) continue;
		if (!rule.pattern.test(out)) {
			throw new Error(
				`[multisite] cannot patch cache "${rule.key}" in ${id}: its declaration no longer matches. ` +
					`EmDash core changed; update RULES in emdash-multisite/src/vite.ts.`,
			);
		}
		out = out.replace(rule.pattern, (_m, name: string, _keyConst: string, init: string) =>
			`const ${name} = __siteScoped(${JSON.stringify(rule.key)}, () => ${init});`);
		patched = true;
	}
	return patched ? `import { siteScoped as __siteScoped } from ${JSON.stringify(VIRTUAL)};\n${out}` : null;
}

// Structural type so this package needs no dependency on `vite`.
interface VitePlugin {
	name: string;
	enforce: "pre";
	resolveId(id: string): string | undefined;
	load(id: string): string | undefined;
	transform(code: string, id: string): { code: string; map: null } | null;
}

export function multisiteCaches(): VitePlugin {
	return {
		name: "emdash-multisite:scope-caches",
		enforce: "pre",
		resolveId: (id) => (id === VIRTUAL ? RESOLVED : undefined),
		load: (id) => (id === RESOLVED ? `export { siteScoped } from ${JSON.stringify(SCOPE_FILE)};` : undefined),
		transform(code, id) {
			const patched = patchCaches(code, id);
			if (patched === null) return null;
			console.log(`[multisite] per-site caches patched in ${id.split("/node_modules/").pop()}`);
			return { code: patched, map: null };
		},
	};
}
