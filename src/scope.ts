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
const SLOT_MEMO = Symbol.for("emdash-multisite:slot-proxies");

interface ScopeState {
	primary: string;
	/** the one shared inner dialect (set when the database descriptor initialises) */
	inner?: import("kysely").Dialect;
	/** resolves the site of the work happening right now */
	activeSite: () => string;
	/** per-site Kysely handle -> site id (core stores that handle in its request context) */
	siteOfDb: WeakMap<object, string>;
	holders: Map<string, object>;
	/** site -> (globalThis symbol slot -> value), for caches read from globalThis on every use */
	slots: Map<string, Map<symbol, unknown>>;
}

// On globalThis so duplicated bundle chunks share one registry.
export function scopeState(): ScopeState {
	const g = globalThis as Record<symbol, unknown>;
	return (g[STATE] ??= {
		primary: "main",
		activeSite: () => activeSite(),
		siteOfDb: new WeakMap(),
		holders: new Map(),
		slots: new Map(),
	}) as ScopeState;
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

/** The nested single-flight cache (its own fields; 1.2.x this WAS the whole memo). */
interface SingleFlight {
	version: number;
	hasValue: boolean;
	value: unknown;
	valueVersion: number;
	lock: { ownerStartedAt: unknown };
}
/**
 * emdash 1.3.x wraps the single-flight cache in a stale-while-revalidate holder:
 * `{ snapshot, expiresAt, generation, revalidatingUntil, refresh: SingleFlight }`.
 * Fields optional so this also covers the 1.2.x bare-SingleFlight shape.
 */
interface SettingsMemo extends Partial<SingleFlight> {
	snapshot?: unknown;
	expiresAt?: number;
	generation?: number;
	revalidatingUntil?: number;
	refresh?: SingleFlight;
}
const lastForget = new Map<string, number>();
/**
 * Drop the active site's memo of its site settings (title, tagline, logo, SEO defaults). Core keeps that memo for the whole
 * isolate lifetime with no TTL, and only the isolate that handled a settings write drops its copy. A render that fills the edge
 * cache right after a purge would otherwise store the OLD title for the whole cache TTL. Same steps as core's
 * `invalidateSingleFlightCache`. At most once per 2 s per site, so a burst of fills after a purge shares one re-read (the
 * trailing purge covers an edit that lands inside that window).
 */
export function forgetSiteSettings(now = Date.now()): void {
	const site = activeSite();
	if (now - (lastForget.get(site) ?? 0) < 2000) return;
	if (lastForget.size > 2000) lastForget.clear();
	lastForget.set(site, now);
	const memo = scopeState().holders.get("emdash:site-settings:swr") as SettingsMemo | undefined;
	if (!memo) return;
	// 1.3.x stale-while-revalidate wrapper: drop the stored snapshot + force a refresh.
	if ("snapshot" in memo || "generation" in memo) {
		memo.snapshot = null;
		memo.expiresAt = 0;
		memo.revalidatingUntil = 0;
		if (typeof memo.generation === "number") memo.generation++;
	}
	// The inner single-flight cache: nested under `.refresh` in 1.3.x, the memo
	// itself in 1.2.x. Clear whichever carries the single-flight fields.
	const sf: Partial<SingleFlight> = memo.refresh ?? memo;
	if (typeof sf.version === "number") sf.version++;
	sf.hasValue = false;
	sf.value = null;
	sf.valueVersion = -1;
	if (sf.lock) sf.lock.ownerStartedAt = null;
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

/**
 * Stand-in for `globalThis` in code that reads a cache from a `Symbol.for` slot
 * on every use (`store[KEY] ?? create`). Reads and writes of the listed keys go
 * to the active site's own slot; everything else passes through to the real
 * globalThis.
 */
export function siteGlobal(keys: readonly string[]): Record<symbol, unknown> {
	const memo = (globalThis as Record<symbol, unknown>)[SLOT_MEMO] as Map<string, Record<symbol, unknown>> | undefined;
	const id = keys.join("|");
	const hit = memo?.get(id);
	if (hit) return hit;
	const scoped = new Set<symbol>(keys.map((k) => Symbol.for(k)));
	const slot = (): Map<symbol, unknown> => {
		const st = scopeState();
		const site = activeSite();
		let m = st.slots.get(site);
		if (!m) st.slots.set(site, (m = new Map()));
		return m;
	};
	const real = globalThis as unknown as Record<symbol, unknown>;
	const proxy = new Proxy(real, {
		get: (t, p) => (scoped.has(p as symbol) ? slot().get(p as symbol) : Reflect.get(t, p, t)),
		set(t, p, v) {
			if (scoped.has(p as symbol)) slot().set(p as symbol, v);
			else Reflect.set(t, p, v, t);
			return true;
		},
		has: (t, p) => (scoped.has(p as symbol) ? slot().has(p as symbol) : Reflect.has(t, p)),
		deleteProperty: (t, p) => (scoped.has(p as symbol) ? slot().delete(p as symbol) : Reflect.deleteProperty(t, p)),
	});
	// Some declarations sit inside functions, so hand back one proxy per key list.
	const table = ((real as Record<symbol, unknown>)[SLOT_MEMO] ??= new Map<string, Record<symbol, unknown>>()) as Map<
		string,
		Record<symbol, unknown>
	>;
	table.set(id, proxy);
	return proxy;
}
