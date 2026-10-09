/** Pure-logic checks for the org -> site hook: `node --no-warnings scripts/orgs.selfcheck.ts` */
import { BUNDLED_THEME, DEFAULT_LIMITS, createProblem, csrfOk, isLocalPath, loginEntryRedirect, seedCollections, switchSummary, effectiveTheme, needsReconcile, isThemeRouteRequest, isThemed, parseCreatedOrg, slugProblem, themeFromMetadata, themeProblem, themeRoute } from "../src/rules.ts";
import { isSiteId } from "../src/rewrite.ts";

let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

const accepts = (s: unknown) => slugProblem(s, "main") === null;
for (const ok of ["acme", "my-company", "a", "a1", "0day", "x".repeat(40)]) check(`slug accepted: ${ok.slice(0, 12)}`, accepts(ok), true);
for (const bad of ["", "-a", "a-", "Acme", "a_b", "a.b", "a b", "x".repeat(41), "a/b", "../x", "ac\u00e9", "a$b", 'a"b', "a;b"]) {
	check(`slug rejected: ${JSON.stringify(bad).slice(0, 16)}`, accepts(bad), false);
}
for (const reserved of ["main", "www", "api", "admin", "auth", "mail", "billing"]) check(`reserved rejected: ${reserved}`, accepts(reserved), false);
check("non-string rejected", [accepts(undefined), accepts(null), accepts(42), accepts({})], [false, false, false, false]);
check("sql-ish slug can never be a site id", isSiteId("acme'; drop table users;--"), false);

const response = {
	name: "Shape Check", slug: "shapecheck", id: "o1",
	members: [{ userId: "u9", role: "member" }, { userId: "u1", role: "owner" }],
};
check("owner picked by role, not position", parseCreatedOrg(response), { slug: "shapecheck", name: "Shape Check", ownerUserId: "u1", theme: null });
check("falls back to first member", parseCreatedOrg({ ...response, members: [{ userId: "u7" }] }), { slug: "shapecheck", name: "Shape Check", ownerUserId: "u7", theme: null });
check("no members -> null", parseCreatedOrg({ ...response, members: [] }), null);
check("no slug -> null", parseCreatedOrg({ ...response, slug: undefined }), null);
check("garbage -> null", [parseCreatedOrg(null), parseCreatedOrg("x"), parseCreatedOrg(42)], [null, null, null]);


// ---- limits ----
const ctx: { userId: string | null; emailVerified: boolean; owned: number; total: number } = { userId: "u1", emailVerified: true, owned: 0, total: 0 };
const code = (c: Partial<typeof ctx>, l = DEFAULT_LIMITS) => createProblem({ ...ctx, ...c }, l)?.code ?? null;
check("fresh verified user may create", code({}), null);
check("anonymous falls through to Better Auth", code({ userId: null, emailVerified: false, owned: 99 }), null);
check("unverified email blocked", code({ emailVerified: false }), "EMAIL_NOT_VERIFIED");
check("default cap is 3 sites per user", [code({ owned: 2 }), code({ owned: 3 })], [null, "SITE_LIMIT_REACHED"]);
check("custom per-user cap", [code({ owned: 0 }, { sitesPerUser: 0 }), code({ owned: 4 }, { sitesPerUser: 5 })], ["SITE_LIMIT_REACHED", null]);
check("no per-user cap when undefined", code({ owned: 1000 }, {}), null);
check("platform cap", [code({ total: 9 }, { totalSites: 10 }), code({ total: 10 }, { totalSites: 10 })], [null, "PLATFORM_FULL"]);
check("verified check comes before limits", code({ emailVerified: false, owned: 99 }), "EMAIL_NOT_VERIFIED");
check("limit message is human", createProblem({ ...ctx, owned: 1 }, { sitesPerUser: 1 })?.message, "You can own up to 1 site.");

// ---- reconcile ----
const now = Date.parse("2026-10-08T12:00:00Z");
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
check("no status -> reconcile", needsReconcile(null, now), true);
check("failed -> reconcile", needsReconcile({ status: "failed", startedAt: iso(1000), error: "x" }, now), true);
check("fresh provisioning -> leave alone", needsReconcile({ status: "provisioning", startedAt: iso(30_000) }, now), false);
check("stale provisioning -> reconcile", needsReconcile({ status: "provisioning", startedAt: iso(10 * 60_000) }, now), true);
check("ready -> never", needsReconcile({ status: "ready", startedAt: iso(1e9), readyAt: iso(1e9) }, now), false);

// ---- themes ----
const themes = { marketing: { name: "Marketing" }, blog: { name: "Blog" } };
check("theme from object metadata", themeFromMetadata({ theme: "blog" }), "blog");
check("theme from JSON-string metadata", themeFromMetadata('{"theme":"blog"}'), "blog");
check("theme absent / garbage -> null", [themeFromMetadata(null), themeFromMetadata("{nope"), themeFromMetadata({ theme: 3 }), themeFromMetadata({})], [null, null, null, null]);
check("known theme accepted", themeProblem("blog", themes), null);
check("absent theme accepted (default applies)", [themeProblem(undefined, themes), themeProblem(null, themes)], [null, null]);
check("unknown / malformed theme rejected", [themeProblem("nope", themes) !== null, themeProblem("../x", themes) !== null, themeProblem(7, themes) !== null, themeProblem("toString", themes) !== null], [true, true, true, true]);
check("requested theme used", effectiveTheme("blog", themes), "blog");
check("missing request -> first theme", effectiveTheme(null, themes), "marketing");
check("explicit default wins", effectiveTheme(null, themes, "blog"), "blog");
check("removed theme falls back", effectiveTheme("gone", themes, "blog"), "blog");
check("no themes configured -> bundled seed", effectiveTheme("blog", undefined), BUNDLED_THEME);
check("theme parsed from created org", parseCreatedOrg({ ...response, metadata: { theme: "blog" } })?.theme, "blog");

// ---- theme routing ----
for (const p of ["/", "/posts", "/posts/hello", "/pricing", "/rss.xml", "/contact", "/about", "/work/x", "/search", "/some-page", "/sitemapper", "/administrator"]) {
	check(`public path is themed: ${p}`, isThemed(p), true);
}
for (const p of ["/_emdash/admin", "/_astro/x.js", "/_image", "/api/auth/get-session", "/auth/sign-in", "/login", "/signup", "/account", "/account/settings", "/organization", "/admin/fleet", "/audit-log", "/sites", "/sites/new", "/.well-known/x", "/sitemap.xml", "/sitemap-posts.xml", "/robots.txt", "/llms.txt", "/theme-routes/blog"]) {
	check(`platform path is not themed: ${p}`, isThemed(p), false);
}
check("route for root has no trailing slash", themeRoute("blog", "/"), "/theme-routes/blog");
check("route for nested path", themeRoute("blog", "/posts/hello"), "/theme-routes/blog/posts/hello");
check("trailing slash dropped", themeRoute("portfolio", "/work/"), "/theme-routes/portfolio/work");
check("direct subtree request detected", [isThemeRouteRequest("/theme-routes/blog"), isThemeRouteRequest("/theme-routes/blog/x"), isThemeRouteRequest("/theme-routesx"), isThemeRouteRequest("/posts")], [true, true, false, false]);

// ---- csrf ----
const hdr = (h: Record<string, string>) => ({ get: (n: string) => h[n.toLowerCase()] ?? null });
check("custom header accepted", csrfOk(hdr({ "x-emdash-request": "1" }), "https://app.example.com"), true);
check("same-origin Origin accepted", csrfOk(hdr({ origin: "https://app.example.com" }), "https://app.example.com"), true);
check("cross-site Origin rejected", csrfOk(hdr({ origin: "https://evil.example" }), "https://app.example.com"), false);
check("no header, no Origin rejected", csrfOk(hdr({}), "https://app.example.com"), false);
check("header with wrong value rejected", csrfOk(hdr({ "x-emdash-request": "0" }), "https://app.example.com"), false);

// ---- theme switching ----
const col = (...slugs: string[]) => ({ seed: { collections: slugs.map((slug) => ({ slug })) } });
const tt = { blog: { name: "Blog", ...col("posts", "pages") }, starter: { name: "Starter", ...col("posts", "pages") }, portfolio: { name: "Portfolio", ...col("projects", "pages") }, marketing: { name: "Marketing", ...col("landing_pages") }, bare: { name: "Bare" } };
check("seed collections listed", seedCollections(tt.blog.seed), ["posts", "pages"]);
check("no seed / garbage -> none", [seedCollections(undefined), seedCollections({}), seedCollections({ collections: [{ slug: 3 }, null] })], [[], [], []]);
check("blog -> starter is lossless", switchSummary(tt, "blog", "starter"), { adds: [], hides: [] });
check("blog -> portfolio adds projects, hides posts", switchSummary(tt, "blog", "portfolio"), { adds: ["projects"], hides: ["posts"] });
check("marketing is additive with the others (own collection)", switchSummary(tt, "marketing", "blog"), { adds: ["posts", "pages"], hides: ["landing_pages"] });
check("seedless theme adds and hides nothing", switchSummary(tt, "bare", "bare"), { adds: [], hides: [] });

// ---- post-login landing ----
const entry = (u: string, signedIn = false) => loginEntryRedirect(new URL(u, "https://app.example.com"), signedIn, "/sites");
check("anonymous sign-in gets the landing as redirect", entry("/auth/sign-in"), "/auth/sign-in?redirect=%2Fsites");
check("sign-up and aliases too", [entry("/auth/sign-up"), entry("/login"), entry("/signup")], ["/auth/sign-up?redirect=%2Fsites", "/login?redirect=%2Fsites", "/signup?redirect=%2Fsites"]);
check("other query params are kept", entry("/auth/sign-in?foo=1"), "/auth/sign-in?foo=1&redirect=%2Fsites");
check("explicit redirect is respected", entry("/login?redirect=%2Fadmin%2Ffleet"), null);
check("signed-in visitor goes to the landing", [entry("/auth/sign-in", true), entry("/login?redirect=%2Fx", true)], ["/sites", "/sites"]);
check("other pages untouched", [entry("/"), entry("/account"), entry("/auth/forgot-password"), entry("/sites")], [null, null, null, null]);
check("local path check", [isLocalPath("/sites"), isLocalPath("//evil.com"), isLocalPath("/\\evil.com"), isLocalPath("https://evil.com"), isLocalPath("sites")], [true, false, false, false, false]);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
