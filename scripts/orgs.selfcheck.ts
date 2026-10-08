/** Pure-logic checks for the org -> site hook: `node --no-warnings scripts/orgs.selfcheck.ts` */
import { parseCreatedOrg, slugProblem } from "../src/orgs.ts";
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
check("owner picked by role, not position", parseCreatedOrg(response), { slug: "shapecheck", name: "Shape Check", ownerUserId: "u1" });
check("falls back to first member", parseCreatedOrg({ ...response, members: [{ userId: "u7" }] }), { slug: "shapecheck", name: "Shape Check", ownerUserId: "u7" });
check("no members -> null", parseCreatedOrg({ ...response, members: [] }), null);
check("no slug -> null", parseCreatedOrg({ ...response, slug: undefined }), null);
check("garbage -> null", [parseCreatedOrg(null), parseCreatedOrg("x"), parseCreatedOrg(42)], [null, null, null]);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
