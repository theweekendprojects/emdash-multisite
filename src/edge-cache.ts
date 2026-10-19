/**
 * Host-aware edge cache helpers. Design, evidence and the incident behind it:
 * emdash-plan/product/hostmyemdash-edge-cache-design.md
 *
 * Why this exists: Cloudflare Workers Cache keys entries by path + query (+ Worker version), NOT by hostname. One Worker serves
 * every site, so the host must be put into the key by a gateway (ctx.props of a cached inner entrypoint). The host Worker
 * (src/worker.ts) owns the two entrypoints; this module owns the rules, so they are testable under plain Node.
 *
 * Principles: default-deny (anything not provably public + anonymous + 200 is `no-store`), fail closed (a response that cannot
 * be tagged to a site is never stored, because it could not be purged), and purge is best-effort but never throws.
 */
import { isThemed } from "./rules.ts";

/** Internal response header: the middleware tells the cache layer which site rendered the response. Stripped before storing. */
export const SITE_HEADER = "x-ms-site";
/** Internal REQUEST header set by the cached entrypoint: only then does the middleware label the response with its site. */
export const EDGE_REQUEST_HEADER = "x-ms-edge";
/** Name of the cached entrypoint exported by the host Worker. */
export const CACHE_ENTRYPOINT = "PublicCache";
export const siteTag = (site: string) => `site:${site}`;

// Core serves these per site (they are not themed) but they are public and safe to cache per host.
const PUBLIC_FILES = /^\/(?:llms\.txt|rss\.xml|robots\.txt|sitemap(?:-[^/]+)?\.xml)$/;
const CACHEABLE_TYPE = /^(?:text\/(?:html|plain|xml)|application\/(?:xml|rss\+xml))/;

/** Lowercase, drop the port and a trailing dot, so `Acme.com.:443` and `acme.com` share one entry. */
export function normalizeHost(h: string): string {
	return h.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
}

/** Anonymous = no Authorization, and no cookies except the privacy plugin's consent cookie (`c15t*`). Anything else counts as signed in. */
export function isAnonymous(headers: Headers): boolean {
	if (headers.has("authorization")) return false;
	const cookie = headers.get("cookie");
	if (!cookie) return true;
	return cookie.split(";").every((c) => {
		const name = c.trim().split("=")[0] ?? "";
		return name === "" || name.startsWith("c15t");
	});
}

/** Request side (gateway): may this request be served from / stored in the shared cache? */
export function cacheableRequest(method: string, url: URL, headers: Headers): boolean {
	if (method !== "GET" && method !== "HEAD") return false;
	if (url.search !== "") return false;
	if (!isAnonymous(headers)) return false;
	return isThemed(url.pathname) || PUBLIC_FILES.test(url.pathname);
}

/**
 * Response side (inner entrypoint): the single choke point. Store only a clean anonymous 200 of an allowed type that the
 * middleware tagged with its site. Everything else gets an explicit `no-store` (Workers Cache would otherwise cache a bare
 * 404 for ~3 min and a bare 200 for ~2 h; verified in the spike). The internal site header is always removed.
 */
export function guardResponse(res: Response): Response {
	const site = res.headers.get(SITE_HEADER);
	const out = new Response(res.body, res);
	out.headers.delete(SITE_HEADER);
	const ok = res.status === 200 && !!site && !res.headers.has("set-cookie") && CACHEABLE_TYPE.test(res.headers.get("content-type") ?? "");
	if (ok) {
		// 1 h + 1 day stale-while-revalidate. Freshness comes from purging the site tag on every edit that changes a public page
		// (hooks in plugin-entry.ts, mutation watcher in middleware.ts); the TTL is only the backstop if a purge is lost.
		out.headers.set("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
		out.headers.set("cache-tag", siteTag(site));
	} else {
		out.headers.set("cache-control", "no-store");
	}
	return out;
}

/** Middleware side: label a successful GET/HEAD response with its site so the cache layer can tag it. */
export function tagSite(res: Response, method: string, site: string): Response {
	if (res.status !== 200 || (method !== "GET" && method !== "HEAD")) return res;
	const out = new Response(res.body, res);
	out.headers.set(SITE_HEADER, site);
	return out;
}

// ---- Which admin writes change a public page -----------------------------------------------------------------------------
// EmDash has plugin hooks for content and bylines only. Menus, widgets, settings, taxonomies, redirects, sections, media
// edits and imports have none, so the middleware watches the admin API instead: a 2xx answer to one of these writes means an
// authorized user changed something. Public routes (form submits, consent saves, ...) are deliberately not listed, otherwise
// any visitor could burn the shared purge budget.
const EDIT_API = "/_emdash/api/";
const ALWAYS_EDIT: RegExp[] = [
	/^(?:menus|widget-areas|settings|sections|taxonomies|redirects|schema|import)(?:\/|$)/,
	/^admin\/(?:transfer\/imports\/[^/]+\/execute|plugins\/[^/]+\/(?:settings|enable|disable|uninstall))$/,
	/^content\/[^/]+\/[^/]+\/terms\//, // term assignment to an entry
	/^revisions\/[^/]+\/restore$/, // collections without revisions write the live row
];
const MEDIA_EDIT = /^media\/[^/]+(?:\/replace)?$/; // PUT/PATCH/DELETE only: new uploads change nothing public until used

export type EditKind = "always" | "content-put" | "content-create";
/** Does this request look like an admin write that can change a public page? `content-*` kinds need the body (see touchesPublicPage). */
export function classifyEdit(method: string, pathname: string): EditKind | null {
	if (method === "GET" || method === "HEAD" || method === "OPTIONS" || !pathname.startsWith(EDIT_API)) return null;
	const rest = pathname.slice(EDIT_API.length).replace(/\/$/, "");
	if (ALWAYS_EDIT.some((r) => r.test(rest))) return "always";
	if (method !== "POST" && MEDIA_EDIT.test(rest)) return "always";
	if ((method === "PUT" || method === "PATCH") && /^content\/[^/]+\/[^/]+$/.test(rest)) return "content-put";
	if (method === "POST" && /^content\/[^/]+$/.test(rest)) return "content-create";
	return null;
}

// Mirrors DRAFT_ONLY_UPDATE_KEYS in emdash core (emdash-runtime.ts): a save that sends only these stages a draft revision and
// leaves the live page unchanged (autosave). Any other key (status, bylines, seo, publishedAt, ...) writes live columns.
// A key core adds later makes us purge more often, never less.
const DRAFT_ONLY_KEYS = new Set(["data", "slug", "locale", "skipRevision", "references", "actor", "migrateBlocks", "replaceBlocks", "_rev"]);
export function touchesPublicPage(kind: EditKind, body: unknown): boolean {
	if (kind === "always") return true;
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
	if (kind === "content-create") return b.status === "published";
	return Object.entries(b).some(([k, v]) => v !== undefined && !DRAFT_ONLY_KEYS.has(k));
}

/**
 * Purge budget. Workers Cache purges always use Cloudflare's FREE-tier limits, whatever the plan: 5 requests per minute
 * (bucket of 25), 100 tags per request, counted per ACCOUNT, so every tenant shares it. A rate-limited purge resolves
 * `{ success: false }` instead of throwing, which is why every send is checked and retried. Ceiling: about two edit bursts
 * per minute across the whole platform once the bucket is empty. Past that, switch to a per-site version in the cache key
 * (no purge calls at all) or batch purges through one Durable Object. Do not call this per keystroke.
 */
const TRAIL_MS = 4000; // a render that began before the edit can finish after the first purge and re-store the old page
const RETRY_MS = 13000; // one token refills every 12 s
const MAX_TRIES = 3;
const MAX_TAGS = 100;

export interface PurgeEnv {
	/** Purge these tags. Resolves false when the purge was not accepted (rate limit, error). Never throws. */
	send(tags: string[]): Promise<boolean>;
	sleep(ms: number): Promise<void>;
	now(): number;
	/** Keep background work alive after the response (waitUntil). */
	defer(work: Promise<unknown>): void;
}

/**
 * Per-isolate purge scheduler. A purge call resolves after the first send (callers never wait for the follow-ups). Then:
 * - same-tick calls for different sites share one send (one budget token);
 * - an edit that lands while a send is in flight is sent again right after it, never dropped;
 * - every purged site is purged once more after TRAIL_MS (an edit during that wait pushes it back);
 * - a rejected send is retried every RETRY_MS, MAX_TRIES attempts in total.
 */
export function createPurger(env: PurgeEnv, log: (e: Record<string, unknown>) => void = () => {}) {
	const pending = new Set<string>();
	const due = new Map<string, { at: number; tries: number }>();
	let draining: Promise<boolean> | null = null;
	let ticking = false;

	const sendAll = async (sites: string[]) => {
		let ok = true;
		for (let i = 0; i < sites.length; i += MAX_TAGS) ok = (await env.send(sites.slice(i, i + MAX_TAGS).map(siteTag))) && ok;
		return ok;
	};
	const schedule = (sites: string[], ms: number, tries: number) => {
		for (const s of sites) due.set(s, { at: env.now() + ms, tries });
		if (!ticking) {
			ticking = true;
			env.defer(tick());
		}
	};
	const tick = async () => {
		try {
			while (due.size) {
				const wait = Math.min(...[...due.values()].map((d) => d.at)) - env.now();
				if (wait > 0) await env.sleep(wait);
				const now = env.now();
				const batch = [...due].filter(([, d]) => d.at <= now);
				if (!batch.length) continue;
				for (const [s] of batch) due.delete(s);
				if (await sendAll(batch.map(([s]) => s))) continue;
				for (const [s, d] of batch) {
					if (d.tries + 1 >= MAX_TRIES) log({ event: "cache.purge_gave_up", site: s });
					else if (!due.has(s)) due.set(s, { at: env.now() + RETRY_MS, tries: d.tries + 1 });
				}
			}
		} finally {
			ticking = false;
		}
	};
	const drain = async () => {
		let ok = true;
		try {
			await 0; // let same-tick callers join this batch
			while (pending.size) {
				const batch = [...pending];
				pending.clear();
				schedule(batch, TRAIL_MS, 0); // before the send: it supersedes any follow-up still waiting for these sites
				const sent = await sendAll(batch);
				ok = sent && ok;
				if (!sent) schedule(batch, RETRY_MS, 1);
			}
		} finally {
			draining = null;
		}
		return ok;
	};
	return (site: string): Promise<boolean> => {
		pending.add(site);
		return (draining ??= drain());
	};
}

type CacheEntry = (o: unknown) => { purgeTag(t: string[]): Promise<{ success?: boolean; errors?: unknown } | undefined> };
async function cacheEntry(): Promise<CacheEntry | null> {
	try {
		const specifier = "cloudflare:workers";
		const { exports } = (await import(/* @vite-ignore */ specifier)) as { exports?: Record<string, CacheEntry | undefined> };
		return exports?.[CACHE_ENTRYPOINT] ?? null;
	} catch {
		return null; // off Workers (Node/SQLite lab)
	}
}
const log = (e: Record<string, unknown>) => console.log(JSON.stringify(e));
const purger = createPurger(
	{
		async send(tags) {
			try {
				const entry = await cacheEntry();
				if (!entry) return true; // nothing cached here, nothing to purge
				const res = await entry({ props: { host: "purge", gpc: false } }).purgeTag(tags);
				const ok = res?.success !== false;
				log(ok ? { event: "cache.purged", tags } : { event: "cache.purge_failed", tags, errors: JSON.stringify(res?.errors ?? null).slice(0, 300) });
				return ok;
			} catch (e) {
				log({ event: "cache.purge_failed", tags, error: String(e) });
				return false;
			}
		},
		sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
		now: Date.now,
		defer(work) {
			const specifier = "cloudflare:workers";
			import(/* @vite-ignore */ specifier).then((m: { waitUntil?: (p: Promise<unknown>) => void }) => m.waitUntil?.(work), () => {});
		},
	},
	log,
);

/**
 * Drop every cached page of a site (all of its hostnames carry the same `site:<slug>` tag). Must run INSIDE the cached
 * entrypoint (a purge from anywhere else reports success and does nothing; verified in the spike), so it calls an RPC method
 * on it. Never throws. Returns whether the first purge was accepted; follow-ups (trailing purge, retries) run in the background.
 */
export async function purgeSiteCache(site: string): Promise<boolean> {
	if (!(await cacheEntry())) return false;
	return purger(site);
}
