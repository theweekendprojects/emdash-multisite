import { currentSite } from "./dialect.ts";

/**
 * Per-site holders for core's process-wide caches.
 *
 * Core keeps many caches as ONE object captured at module load. The build-time
 * patch (see vite.ts) replaces each such object with `siteScoped(key, init)`:
 * a Proxy that forwards every operation to a separate real object per site.
 */

const STATE = Symbol.for("emdash-multisite:state");
const REQUEST_CONTEXT = Symbol.for("emdash:request-context");

interface ScopeState {
	primary: string;
	/** per-site Kysely handle -> site id (core stores that handle in its request context) */
	siteOfDb: WeakMap<object, string>;
	holders: Map<string, object>;
}

// On globalThis so duplicated bundle chunks share one registry.
export function scopeState(): ScopeState {
	const g = globalThis as Record<symbol, unknown>;
	return (g[STATE] ??= { primary: "main", siteOfDb: new WeakMap(), holders: new Map() }) as ScopeState;
}

/** Site the current work belongs to: request's db handle, else runAsSite, else primary. */
export function activeSite(): string {
	const st = scopeState();
	const als = (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT] as
		| { getStore(): { db?: object } | undefined }
		| undefined;
	const db = als?.getStore()?.db;
	return (db && st.siteOfDb.get(db)) ?? currentSite() ?? st.primary;
}

export function siteScoped<T extends object>(key: string, init: () => T): T {
	const st = scopeState();
	const existing = st.holders.get(key);
	if (existing) return existing as T;

	const perSite = new Map<string, T>();
	const real = (): T => {
		const site = activeSite();
		let v = perSite.get(site);
		if (!v) {
			v = init();
			perSite.set(site, v);
		}
		return v;
	};
	// ponytail: methods are re-bound on every read, so function identity is not
	// stable across reads. Core only calls them; revisit if something compares them.
	const proxy = new Proxy({} as T, {
		get(_t, p) {
			const r = real();
			const v = Reflect.get(r, p, r);
			return typeof v === "function" ? v.bind(r) : v;
		},
		set: (_t, p, v) => Reflect.set(real(), p, v),
		has: (_t, p) => Reflect.has(real(), p),
		deleteProperty: (_t, p) => Reflect.deleteProperty(real(), p),
		ownKeys: () => Reflect.ownKeys(real()),
		getOwnPropertyDescriptor(_t, p) {
			const d = Reflect.getOwnPropertyDescriptor(real(), p);
			if (d) d.configurable = true;
			return d;
		},
		defineProperty: (_t, p, d) => Reflect.defineProperty(real(), p, d),
		getPrototypeOf: () => Reflect.getPrototypeOf(real()),
	});
	st.holders.set(key, proxy);
	return proxy;
}
