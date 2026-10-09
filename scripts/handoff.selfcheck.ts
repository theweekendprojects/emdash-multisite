/** Checks for the control-plane -> tenant handoff token: `node --no-warnings scripts/handoff.selfcheck.ts` */
import { HANDOFF_TTL_MS, signHandoff, verifyHandoff } from "../src/handoff.ts";
let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};
const now = 1_000_000;
const token = await signHandoff("s3cret", { uid: "u1", site: "acme" }, now);
const ok = await verifyHandoff("s3cret", token, "acme", now + 1000);
check("valid token verifies", [ok?.uid, ok?.site], ["u1", "acme"]);
check("wrong secret rejected", await verifyHandoff("other", token, "acme", now), null);
check("other site rejected", await verifyHandoff("s3cret", token, "demo", now), null);
check("expired rejected", await verifyHandoff("s3cret", token, "acme", now + HANDOFF_TTL_MS + 1), null);
const [body, sig] = token.split(".");
const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), uid: "admin" })).toString("base64url");
check("tampered payload rejected", await verifyHandoff("s3cret", `${forged}.${sig}`, "acme", now), null);
check("garbage rejected", [await verifyHandoff("s3cret", "", "acme", now), await verifyHandoff("s3cret", "a.b.c", "acme", now), await verifyHandoff("s3cret", "x", "acme", now)], [null, null, null]);
const t2 = await signHandoff("s3cret", { uid: "u1", site: "acme" }, now);
check("each token has its own nonce", (await verifyHandoff("s3cret", token, "acme", now))?.nonce !== (await verifyHandoff("s3cret", t2, "acme", now))?.nonce, true);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
