import { fileURLToPath } from "node:url";

/**
 * Build-time patch: make core's process-wide caches per-site.
 *
 * Core keeps each cache as ONE object on `globalThis`, captured when the module
 * loads (or re-read from a `Symbol.for` slot on every use), so the wrapper
 * cannot swap it per request. This plugin rewrites those declarations in core's
 * published code:
 *   - "holder" caches:  `const x = g[KEY] ?? (() => {...})()`  ->  `siteScoped(key, init)`
 *   - "slot" caches:    `const store = globalThis`              ->  `siteGlobal([keys])`
 *
 * Fail-closed, in two ways:
 *   1. a known cache whose declaration no longer matches errors the build;
 *   2. a `Symbol.for("emdash:...")` key that is neither patched nor listed as
 *      site-independent errors the build (core added a cache we don't know).
 */

/** Caches declared as `const x = g[KEY] ?? (() => {...create + store...})()`. */
export const HOLDER_KEYS = [
	// emdash 1.3.x versioned/renamed these per-site holders (was site-settings,
	// collection-slugs, taxonomy-defs). The @N suffix is core's cache-key version.
	"emdash:site-settings:swr",
	"emdash:collection-slugs@2",
	"emdash:taxonomy-defs@2",
	"emdash:taxonomy-names",
	// emdash 1.4.0 (#4243) added stale-while-revalidate variants of the taxonomy
	// holders. Same per-site taxonomy data; still holders.
	"emdash:taxonomy-names:swr",
	"emdash:taxonomy-defs:swr",
	"emdash:byline-field-defs",
	// emdash 1.4.0: memoized resolved menu URLs, keyed by name:locale:trailingSlash.
	// Per-site content (each tenant's menus differ), so scope it per site.
	"emdash:menu-resolved-namespaces",
	"emdash:url-pattern-cache",
	"emdash:redirect-cache",
	"emdash:redirect-artifact-repair",
] as const;

/** Caches re-read from a `Symbol.for` slot on every use through a `globalThis` alias. */
export const SLOT_KEYS = [
	"emdash:db-cache",
	"emdash:seed-state",
	"emdash:runtime-holder",
	"emdash:setup-verified",
	"@emdash-cms/core/secrets-cache@2",
	// Per-key promise locks for media-usage refreshes; two sites sharing a collection name
	// ("posts") would otherwise serialise behind, or inherit failures from, each other.
	"emdash.mediaUsage.contentLocks",
	"emdash.mediaUsage.collectionLocks",
	// Synonyms come from the site's own KV settings.
	"emdash.ai-search.synonym-cache",
] as const;

/**
 * Keys that hold no per-site data (build config, per-request state, platform
 * health), so sharing them across sites is correct.
 */
export const SITE_INDEPENDENT_KEYS: Readonly<Record<string, string>> = {
	"emdash:stored-config": "build-time config; one build serves every site",
	"emdash:i18n-config": "build-time config",
	"emdash:request-context": "AsyncLocalStorage; per request",
	"emdash:request-cache": "WeakMap keyed by request context; per request",
	"emdash:request-scoped-dbs": "WeakSet of handles; holds no data",
	"emdash:deferred-tasks": "in-flight promise tracker",
	"emdash:content-save-hook-context": "AsyncLocalStorage; per request",
	"emdash:dev-emails": "dev console store",
	"emdash:foldedTerms": "per-row marker, not a cache",
	"emdash:foldedAuthorByline": "per-row marker on the data object (emdash 1.4.0 #4167), not a cache",
	"emdash:foldedBylines": "per-row marker, not a cache",
	"emdash:foldedBylinesExist": "per-row marker, not a cache",
	"emdash:migration-config": "build-time integration metadata",
	"emdash:d1-session-guard": "platform health latch",
	"emdash:do-singleton-bookmark-sinks": "keyed per Durable Object",
	"emdash:inline-code-block-lowlight": "library instance",
	"emdash:admin-code-block-lowlight": "library instance",
	"emdash:sandbox-media-storage-callback": "sandboxed plugins unsupported in v1",
	"emdash.ai-search.workers-module": "process-wide module import",
	"emdash.ai-search.config": "build-time plugin config; same for every site",
	"emdash.registry.publisherHandles": "ATProto handle lookups on the public network; identical for every site",
	"emdash.registry.authoritativeRecordReader": "test override slot",
	"emdash.openapi.cachedSpec": "built only from build-time config (maxUploadSize); no site data",
	"@emdash-cms/cloudflare:astro-app": "the Astro app object; one build serves every site",
	"@emdash-cms/cloudflare:cache-provider": "platform cache provider; one per Worker",
	"emdash:auth:microsoft-jwks": "Microsoft's public signing keys, keyed by Microsoft tenant; identical for every site",
	"emdash:warned-deprecated-capability-plugins": "log-once set of plugin ids",
	// ponytail: only site-independent while the opt-in object cache is OFF. With it on, the
	// shared KV needs a per-site key prefix (not built yet), so do not enable it multi-site.
	"emdash:object-cache:memory": "object cache (opt-in, off by default)",
	"emdash:object-cache:backend": "object cache (opt-in, off by default)",
	"emdash:object-cache:epochs": "object cache (opt-in, off by default)",
	"emdash:object-cache:pending-bumps": "object cache (opt-in, off by default)",
	"emdash:object-cache:last-content-write": "object cache (opt-in, off by default)",
	"emdash:object-cache:pending-content-write": "object cache (opt-in, off by default)",
	"emdash:object-cache:write-scope": "object cache (opt-in, off by default)",
	// ponytail: sandboxed plugins are not supported multi-site in v1 (their bridge opens its own DB).
	"emdash:sandbox-content-create-callbacks": "sandboxed plugins unsupported in v1",
	"emdash:sandbox-taxonomy-write-callbacks": "sandboxed plugins unsupported in v1",
	"emdash:sandbox-content-action-callbacks": "sandboxed plugins unsupported in v1",
};

// Every Symbol.for key owned by EmDash code: "emdash:..", "emdash.x.y" and "@emdash-cms/..".
// (Not astro.* or other libraries' keys.)
const KEY_PATTERN = /Symbol\.for\("((?:emdash[:.]|@emdash-cms\/)[^"]*)"\)/g;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names of the constants bound to `Symbol.for("<key>")` in this module. */
function keyConsts(code: string, key: string): string[] {
	const re = new RegExp(`(?:const|let|var) (\\w+)(?::[^=\\n]+)? = Symbol\\.for\\("${escapeRe(key)}"\\)`, "g");
	return [...code.matchAll(re)].map((m) => m[1]!);
}

/** Cache keys mentioned in a module. */
export function keysIn(code: string): string[] {
	return [...new Set([...code.matchAll(KEY_PATTERN)].map((m) => m[1]!))];
}

const VIRTUAL = "virtual:emdash-multisite/scope";
const RESOLVED = `\0${VIRTUAL}`;
const SCOPE_FILE = fileURLToPath(new URL("./scope.ts", import.meta.url));

function patchHolder(code: string, key: string, id: string): string {
	const consts = keyConsts(code, key);
	// dist:  const c = g[KEY] ?? (() => {...})();
	// src :  const c: Type =\n // comment\n (g[KEY] as Type | undefined) ??\n (() => {...})();
	// src (1.4.0 globalThis-cast style):
	//        const c: Type =\n // comment\n ((globalThis as Record<symbol, unknown>)[KEY] as\n | Type\n | undefined) ??\n (() => {...})();
	// The store accessor is either a bare alias `g[KEY]` or a parenthesized cast
	// `(globalThis as Record<symbol, unknown>)[KEY]`, and the trailing `as <Type>`
	// may span multiple lines, so match the accessor and cast newline-tolerantly.
	for (const k of consts) {
		const re = new RegExp(
			`const (\\w+)(?::[^=\\n]+)? =\\s*(?:\\/\\/[^\\n]*\\n\\s*)*\\(*\\s*(?:\\(globalThis as [^)]+\\)|\\w+)\\[${k}\\](?:\\s+as\\s[\\s\\S]*?)?\\s*\\)*\\s*\\?\\?\\s*(\\(\\(\\) => \\{[\\s\\S]*?\\n?\\s*\\}\\)\\(\\));`,
		);
		if (re.test(code)) {
			return code.replace(re, (_m, name: string, init: string) =>
				`const ${name} = __siteScoped(${JSON.stringify(key)}, () => ${init});`);
		}
	}
	throw new Error(
		`[multisite] cannot patch cache "${key}" in ${id}: its declaration no longer matches the expected shape. ` +
			`EmDash core changed; update patchHolder in emdash-multisite/src/vite.ts.`,
	);
}

/**
 * Rewrite the `const alias = globalThis` that belongs to each slot cache.
 *
 * An alias name like `holder` or `g` is often reused by unrelated functions in
 * one bundled file, so the declaration is chosen by position: the closest
 * `<alias> = globalThis` BEFORE the first `alias[KEY]` use of that key. Aliases
 * are patched individually, each with only the keys it is used with.
 */
function patchSlots(code: string, keys: string[], id: string): string {
	// alias declaration offset -> keys read through it
	const byDecl = new Map<number, { alias: string; keys: Set<string> }>();
	for (const key of keys) {
		const consts = keyConsts(code, key);
		if (consts.length === 0) {
			throw new Error(`[multisite] cannot patch cache "${key}" in ${id}: no Symbol.for constant found.`);
		}
		let used = false;
		for (const k of consts) {
			for (const m of code.matchAll(new RegExp(`(\\w+)\\[${k}\\]`, "g"))) {
				used = true;
				const alias = m[1]!;
				const declRe = new RegExp(`(?:const|let) ${alias}(?::[^=\\n]+)? = globalThis(?: as [^;\\n]+)?;`, "g");
				let best: number | undefined;
				for (const d of code.matchAll(declRe)) {
					if (d.index! < m.index!) best = d.index!;
				}
				if (best === undefined) {
					throw new Error(
						`[multisite] cannot patch cache "${key}" in ${id}: no \`${alias} = globalThis\` precedes its use.`,
					);
				}
				const entry = byDecl.get(best) ?? { alias, keys: new Set<string>() };
				entry.keys.add(key);
				byDecl.set(best, entry);
			}
		}
		if (!used) throw new Error(`[multisite] cannot patch cache "${key}" in ${id}: no slot access found.`);
	}
	// Apply from the end so earlier offsets stay valid.
	let out = code;
	for (const [offset, { alias, keys: ks }] of [...byDecl].sort((a, b) => b[0] - a[0])) {
		const declRe = new RegExp(`((?:const|let) ${alias}(?::[^=\\n]+)? = )globalThis(?: as [^;\\n]+)?;`, "y");
		declRe.lastIndex = offset;
		const m = declRe.exec(out);
		if (!m) throw new Error(`[multisite] internal: lost declaration of "${alias}" in ${id}.`);
		const replacement = `${m[1]}__siteGlobal(${JSON.stringify([...ks])});`;
		out = out.slice(0, offset) + replacement + out.slice(offset + m[0].length);
	}
	return out;
}

/**
 * Rewrite one module. Returns null when it holds no cache keys. Throws when a
 * known cache cannot be patched or an unknown cache key appears.
 */
export function patchCaches(code: string, id: string): string | null {
	const found = keysIn(code);
	if (found.length === 0) return null;

	const unknown = found.filter(
		(k) =>
			!(HOLDER_KEYS as readonly string[]).includes(k) &&
			!(SLOT_KEYS as readonly string[]).includes(k) &&
			!(k in SITE_INDEPENDENT_KEYS),
	);
	if (unknown.length > 0) {
		throw new Error(
			`[multisite] unknown core cache key(s) ${unknown.map((k) => `"${k}"`).join(", ")} in ${id}. ` +
				`Decide whether each holds per-site data, then add it to HOLDER_KEYS, SLOT_KEYS or SITE_INDEPENDENT_KEYS ` +
				`in emdash-multisite/src/vite.ts.`,
		);
	}

	let out = code;
	const holders = found.filter((k) => (HOLDER_KEYS as readonly string[]).includes(k));
	const slots = found.filter((k) => (SLOT_KEYS as readonly string[]).includes(k));
	for (const key of holders) out = patchHolder(out, key, id);
	if (slots.length > 0) out = patchSlots(out, slots, id);
	if (holders.length === 0 && slots.length === 0) return null;

	const imports = [
		holders.length > 0 ? "siteScoped as __siteScoped" : "",
		slots.length > 0 ? "siteGlobal as __siteGlobal" : "",
	].filter(Boolean);
	return `import { ${imports.join(", ")} } from ${JSON.stringify(VIRTUAL)};\n${out}`;
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
		load: (id) =>
			id === RESOLVED ? `export { siteScoped, siteGlobal } from ${JSON.stringify(SCOPE_FILE)};` : undefined,
		transform(code, id) {
			const patched = patchCaches(code, id);
			if (patched === null) return null;
			console.log(`[multisite] per-site caches patched in ${id.split("/node_modules/").pop()}`);
			return { code: patched, map: null };
		},
	};
}
