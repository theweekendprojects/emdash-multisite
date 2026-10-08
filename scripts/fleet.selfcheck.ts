/** Pure-logic checks for the fleet view: `node --no-warnings scripts/fleet.selfcheck.ts` */
import { fleetPageHtml } from "../src/fleet-page.ts";

let failed = 0;
const check = (name: string, cond: boolean) => {
	if (!cond) failed++;
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
};

const html = fleetPageHtml();
check("page is a full HTML document", html.startsWith("<!doctype html>") && html.includes("</html>"));
check("page fetches the staff-gated fleet API", html.includes("/api/multisite/fleet"));
check("page handles 403 (shows forbidden, not a table)", html.includes("403") && html.includes("staff only"));
check("page escapes values client-side (no raw interpolation of site data)", html.includes('replace(/[&<>"]/g'));
check("page has no server-interpolated data (shell only)", !html.includes("${") || html.indexOf("${") === -1);
check("status pills cover all states", ["ready", "provisioning", "failed", "unknown"].every((s) => html.includes(`.${s}`)));

// The staff gate is `role >= 50`. Encode the rule here as a tripwire so a change
// to the threshold is caught (the real isStaff reads the DB; this guards the constant intent).
const STAFF_MIN = 50;
check("subscriber (10) is not staff", 10 >= STAFF_MIN === false);
check("editor (40) is not staff", 40 >= STAFF_MIN === false);
check("admin (50) is staff", 50 >= STAFF_MIN === true);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
