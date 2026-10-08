/** Pure-logic checks for the org -> site hook: `node --no-warnings scripts/orgs.selfcheck.ts` */
import { BUNDLED_THEME, DEFAULT_LIMITS, createProblem, effectiveTheme, needsReconcile, parseCreatedOrg, slugProblem, themeFromMetadata, themeProblem } from "../src/rules.ts";
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
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
