/** Runnable self-check (no framework): `node --no-warnings scripts/edge-cache.selfcheck.ts`. Pins the cache rules that stop the 2026-10-18 outage. */
import { SITE_HEADER, cacheableRequest, guardResponse, isAnonymous, normalizeHost, purgeSiteCache, siteTag, tagSite } from "../src/edge-cache.ts";
let failed = 0;
const eq = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const H = (o: Record<string, string> = {}) => new Headers(o);
const U = (p: string) => new URL(`https://acme.example.com${p}`);

// host normalisation: one entry per host
eq("host: case, port, trailing dot", normalizeHost("Acme.Example.COM.:443"), "acme.example.com");

// anonymous detection
eq("anon: no cookie", isAnonymous(H()), true);
eq("anon: consent cookie only", isAnonymous(H({ cookie: "c15t=abc; c15t_x=1" })), true);
eq("anon: session cookie", isAnonymous(H({ cookie: "better-auth.session_token=x" })), false);
eq("anon: consent + session cookie", isAnonymous(H({ cookie: "c15t=1; better-auth.session_token=x" })), false);
eq("anon: any unknown cookie counts as signed in", isAnonymous(H({ cookie: "foo=bar" })), false);
eq("anon: authorization header", isAnonymous(H({ authorization: "Bearer x" })), false);

// request side
eq("req: home", cacheableRequest("GET", U("/"), H()), true);
eq("req: post page", cacheableRequest("GET", U("/posts/hello"), H()), true);
eq("req: llms.txt", cacheableRequest("GET", U("/llms.txt"), H()), true);
eq("req: sitemap index + sub", [cacheableRequest("GET", U("/sitemap.xml"), H()), cacheableRequest("GET", U("/sitemap-posts.xml"), H())], [true, true]);
eq("req: HEAD ok", cacheableRequest("HEAD", U("/"), H()), true);
eq("req: POST never", cacheableRequest("POST", U("/"), H()), false);
eq("req: query string never", cacheableRequest("GET", U("/?preview=tok"), H()), false);
eq("req: signed in never", cacheableRequest("GET", U("/"), H({ cookie: "better-auth.session_token=x" })), false);
eq("req: admin never", cacheableRequest("GET", U("/_emdash/admin"), H()), false);
eq("req: auth api never", cacheableRequest("GET", U("/api/auth/get-session"), H()), false);
eq("req: account never", cacheableRequest("GET", U("/account/home"), H()), false);
eq("req: sign-in page never", cacheableRequest("GET", U("/auth/sign-in"), H()), false);
eq("req: login redirect path never", cacheableRequest("GET", U("/login"), H()), false);

// response side (default-deny)
const html = (init: ResponseInit & { site?: string | null } = {}) => {
	const { site = "acme", ...rest } = init;
	const h = new Headers({ "content-type": "text/html; charset=utf-8", ...(rest.headers as Record<string, string> | undefined) });
	if (site) h.set(SITE_HEADER, site);
	return new Response("<p>x</p>", { status: 200, ...rest, headers: h });
};
const g = guardResponse(html());
eq("guard: clean 200 stored", g.headers.get("cache-control"), "public, max-age=300, stale-while-revalidate=86400");
eq("guard: tagged by site", g.headers.get("cache-tag"), siteTag("acme"));
eq("guard: internal header stripped", g.headers.has(SITE_HEADER), false);
eq("guard: 404 no-store", guardResponse(html({ status: 404 })).headers.get("cache-control"), "no-store");
eq("guard: 404 never tagged", guardResponse(html({ status: 404 })).headers.has("cache-tag"), false);
eq("guard: 302 no-store", guardResponse(html({ status: 302 })).headers.get("cache-control"), "no-store");
eq("guard: 500 no-store", guardResponse(html({ status: 500 })).headers.get("cache-control"), "no-store");
eq("guard: set-cookie no-store", guardResponse(html({ headers: { "set-cookie": "a=b" } })).headers.get("cache-control"), "no-store");
eq("guard: untagged (no site) fails closed", guardResponse(html({ site: null })).headers.get("cache-control"), "no-store");
eq("guard: json no-store", guardResponse(html({ headers: { "content-type": "application/json" } })).headers.get("cache-control"), "no-store");
eq("guard: plain text ok (llms.txt)", guardResponse(html({ headers: { "content-type": "text/plain; charset=utf-8" } })).headers.get("cache-tag"), "site:acme");
eq("guard: rss ok", guardResponse(html({ headers: { "content-type": "application/rss+xml; charset=utf-8" } })).headers.get("cache-tag"), "site:acme");
eq("guard: overrides a permissive upstream cache-control on errors", guardResponse(html({ status: 404, headers: { "cache-control": "public, max-age=3600" } })).headers.get("cache-control"), "no-store");
eq("guard: keeps body", await guardResponse(html()).text(), "<p>x</p>");

// tagging in the middleware
eq("tag: 200 GET tagged", tagSite(new Response("x"), "GET", "acme").headers.get(SITE_HEADER), "acme");
eq("tag: 404 untouched", tagSite(new Response("x", { status: 404 }), "GET", "acme").headers.has(SITE_HEADER), false);
eq("tag: POST untouched", tagSite(new Response("x"), "POST", "acme").headers.has(SITE_HEADER), false);

// purge is safe off Workers and coalesces
eq("purge: off Workers is a quiet no-op", await purgeSiteCache("acme", 1_000_000), false);
eq("purge: second call within 2 s is skipped", await purgeSiteCache("acme", 1_000_500), false);

if (failed) {
	console.log(`\n${failed} FAILED`);
	process.exit(1);
}
console.log("\nedge-cache selfcheck OK");
