/** Runnable self-check (no framework): `node --no-warnings scripts/edge-cache.selfcheck.ts`. Pins the cache rules that stop the 2026-10-18 outage. */
import { forgetSiteSettings, siteScoped } from "../src/scope.ts";
import { SITE_HEADER, cacheableRequest, classifyEdit, createPurger, guardResponse, isAnonymous, normalizeHost, purgeSiteCache, siteTag, tagSite, touchesPublicPage, type PurgeEnv } from "../src/edge-cache.ts";
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
eq("guard: clean 200 stored", g.headers.get("cache-control"), "public, max-age=3600, stale-while-revalidate=86400");
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

// which admin writes change a public page
const A = "/_emdash/api/";
const kind = (m: string, p: string) => classifyEdit(m, A + p);
eq("edit: menu write", kind("PUT", "menus/main"), "always");
eq("edit: menu item delete", kind("DELETE", "menus/main/items/7"), "always");
eq("edit: widget reorder", kind("POST", "widget-areas/sidebar/reorder"), "always");
eq("edit: site settings", kind("POST", "settings"), "always");
eq("edit: taxonomy term", kind("PUT", "taxonomies/category/terms/news"), "always");
eq("edit: redirect", kind("POST", "redirects"), "always");
eq("edit: section", kind("PUT", "sections/hero"), "always");
eq("edit: term assignment", kind("POST", "content/posts/abc/terms/category"), "always");
eq("edit: plugin settings", kind("PUT", "admin/plugins/seo/settings"), "always");
eq("edit: media delete / replace / metadata", [kind("DELETE", "media/m1"), kind("PUT", "media/m1/replace"), kind("PUT", "media/m1")], ["always", "always", "always"]);
eq("edit: media upload is not an edit", [kind("POST", "media"), kind("POST", "media/m1/confirm"), kind("POST", "media/upload-url"), kind("POST", "media/m1")], [null, null, null, null]);
eq("edit: revision restore", kind("POST", "revisions/r1/restore"), "always");
eq("edit: content save needs the body", kind("PUT", "content/posts/abc"), "content-put");
eq("edit: content create needs the body", kind("POST", "content/posts"), "content-create");
eq("edit: GET never", kind("GET", "menus/main"), null);
eq("edit: public plugin routes never (visitors could burn the purge budget)", [kind("POST", "plugins/emdash-privacy/save"), kind("POST", "plugins/forms/submit"), kind("POST", "plugins/seo/admin")], [null, null, null]);
eq("edit: other paths never", [classifyEdit("POST", "/api/auth/sign-in"), classifyEdit("POST", "/contact")], [null, null]);
eq("edit: autosave body is not a public change", touchesPublicPage("content-put", { data: { title: "x" }, slug: "x", skipRevision: true, _rev: "1", references: {} }), false);
eq("edit: undefined live keys do not count", touchesPublicPage("content-put", { data: {}, bylines: undefined }), false);
eq("edit: bylines / seo / status / publishedAt are public", ["bylines", "seo", "status", "publishedAt", "authorId"].map((k) => touchesPublicPage("content-put", { data: {}, [k]: 1 })), [true, true, true, true, true]);
eq("edit: create as draft is not public", touchesPublicPage("content-create", { status: "draft", data: {} }), false);
eq("edit: create as published is public", touchesPublicPage("content-create", { status: "published", data: {} }), true);
eq("edit: unparsable body is not public", touchesPublicPage("content-put", null), false);
eq("edit: always ignores the body", touchesPublicPage("always", null), true);

// purge is a quiet no-op off Workers
eq("purge: off Workers is a quiet no-op", await purgeSiteCache("acme"), false);

// purge scheduler with a fake clock: sleeps block until settle() wakes them in order, so "before settle" = leading sends only
function lab(opts: { accept?: (n: number) => boolean; onWake?: () => void; gate?: Promise<void> } = {}) {
	let t = 0;
	const sends: { t: number; tags: string[] }[] = [];
	const work: Promise<unknown>[] = [];
	const sleepers: (() => void)[] = [];
	const env: PurgeEnv = {
		async send(tags) {
			sends.push({ t, tags });
			if (sends.length === 1) await opts.gate;
			return opts.accept ? opts.accept(sends.length) : true;
		},
		sleep: (ms) =>
			new Promise<void>((res) =>
				sleepers.push(() => {
					t += ms / 2;
					opts.onWake?.(); // an edit lands halfway through the wait
					t += ms / 2;
					res();
				}),
			),
		now: () => t,
		defer: (p) => void work.push(p),
	};
	const purge = createPurger(env);
	const flush = async () => {
		for (let i = 0; i < 20; i++) await 0;
	};
	const settle = async () => {
		for (;;) {
			await flush();
			const wake = sleepers.shift();
			if (!wake) break;
			wake();
		}
		await Promise.all(work);
	};
	return { purge, sends, settle, flush, clock: () => t };
}
{
	const l = lab();
	eq("purger: first send is immediate", await l.purge("a"), true);
	await l.flush();
	eq("purger: one send, no waiting, before the follow-up", [l.sends.length, l.clock()], [1, 0]);
	await l.settle();
	eq("purger: trailing purge 4 s later", l.sends.map((s) => [s.t, s.tags]), [[0, ["site:a"]], [4000, ["site:a"]]]);
}
{
	const l = lab();
	await Promise.all([l.purge("a"), l.purge("b"), l.purge("a")]);
	await l.flush();
	eq("purger: same-tick calls share one send", l.sends.map((s) => s.tags), [["site:a", "site:b"]]);
	await l.settle();
	eq("purger: trailing is also one send", l.sends.length, 2);
}
{
	let release!: () => void;
	const l = lab({ gate: new Promise<void>((r) => (release = r)) });
	const first = l.purge("a");
	await l.flush();
	const second = l.purge("a"); // lands while the first send is in flight
	release();
	await Promise.all([first, second]);
	await l.flush();
	eq("purger: an edit during an in-flight send is sent again, not dropped", l.sends.map((s) => s.t), [0, 0]);
	await l.settle();
	eq("purger: and the trailing purge is still one", l.sends.map((s) => s.t), [0, 0, 4000]);
}
{
	let wakes = 0;
	const l = lab({ onWake: () => wakes++ === 0 && void l.purge("a") });
	await l.purge("a");
	await l.settle();
	eq("purger: an edit during the trailing wait pushes the trailing purge back", l.sends.map((s) => s.t), [0, 4000, 8000]);
}
{
	const l = lab({ accept: (n) => n > 1 });
	eq("purger: a rejected send reports false", await l.purge("a"), false);
	await l.settle();
	eq("purger: rejected send is retried after 13 s, then done", l.sends.map((s) => s.t), [0, 13000]);
}
{
	const l = lab({ accept: () => false });
	await l.purge("a");
	await l.settle();
	eq("purger: gives up after 3 attempts", l.sends.map((s) => s.t), [0, 13000, 26000]);
}
{
	const l = lab();
	await Promise.all(Array.from({ length: 150 }, (_, i) => l.purge(`s${i}`)));
	await l.flush();
	eq("purger: at most 100 tags per send", l.sends.map((s) => s.tags.length), [100, 50]);
	await l.settle();
}

// cache-filling renders drop core's per-isolate site-settings memo
{
	const memo = siteScoped("emdash:site-settings", () => ({ version: 0, hasValue: true, value: { title: "old" }, valueVersion: 0, lock: { ownerStartedAt: 123 as number | null } }));
	forgetSiteSettings(10_000);
	eq("settings memo: dropped", [memo.hasValue, memo.value, memo.version, memo.valueVersion, memo.lock.ownerStartedAt], [false, null, 1, -1, null]);
	memo.hasValue = true;
	forgetSiteSettings(10_500);
	eq("settings memo: a burst of fills within 2 s shares one re-read", [memo.hasValue, memo.version], [true, 1]);
	forgetSiteSettings(12_500);
	eq("settings memo: dropped again after 2 s", [memo.hasValue, memo.version], [false, 2]);
}

if (failed) {
	console.log(`\n${failed} FAILED`);
	process.exit(1);
}
console.log("\nedge-cache selfcheck OK");
