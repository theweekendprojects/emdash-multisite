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
		// ponytail: 5 min + 1 day stale-while-revalidate. Purge-by-site (state changes, content publish) bounds staleness; site settings,
		// menus and widgets have no hook yet, so those edits show after the TTL. Raise the TTL once those hooks exist.
		out.headers.set("cache-control", "public, max-age=300, stale-while-revalidate=86400");
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

const lastPurge = new Map<string, number>();
/**
 * Drop every cached page of a site (all of its hostnames carry the same `site:<slug>` tag). Must run INSIDE the cached
 * entrypoint (a purge from anywhere else reports success and does nothing; verified in the spike), so it calls an RPC method
 * on it. Never throws: a failed purge only means pages age out at the TTL. Returns whether a purge was sent.
 * ponytail: per-isolate coalescing (2 s) keeps an editing burst from spamming the purge API. Ceiling: another isolate can still
 * purge in the same second; Cloudflare's purge limits apply to Workers Cache at Free-tier levels, so do not call this per keystroke.
 */
export async function purgeSiteCache(site: string, now = Date.now()): Promise<boolean> {
	const prev = lastPurge.get(site);
	if (prev !== undefined && now - prev < 2000) return false;
	lastPurge.set(site, now);
	try {
		const specifier = "cloudflare:workers";
		const { exports } = (await import(/* @vite-ignore */ specifier)) as { exports?: Record<string, ((o: unknown) => { purgeTag(t: string): Promise<unknown> }) | undefined> };
		const entry = exports?.[CACHE_ENTRYPOINT];
		if (!entry) return false; // off Workers (Node/SQLite lab) or caching not deployed
		await entry({ props: { host: "purge", gpc: false } }).purgeTag(siteTag(site));
		console.log(JSON.stringify({ event: "cache.purged", site }));
		return true;
	} catch (e) {
		console.log(JSON.stringify({ event: "cache.purge_failed", site, error: String(e) }));
		return false;
	}
}
