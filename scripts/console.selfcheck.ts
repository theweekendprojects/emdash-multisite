/** Checks for the customer console: `node --no-warnings scripts/console.selfcheck.ts` */
import { consolePageHtml } from "../src/console-page.ts";
import { fleetPageHtml } from "../src/fleet-page.ts";
import { siteUrl } from "../src/sites.ts";
let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// The client script is a string inside a template literal: a stray backtick or a
// syntax slip only shows up in the browser. `new Function` parses without running.
for (const mode of ["list", "new", "appearance"] as const) {
	const html = consolePageHtml(mode, "my-site");
	const script = html.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
	let parsed = true;
	try {
		new Function(script);
	} catch (e) {
		parsed = false;
		console.log(String(e));
	}
	check(`client script parses (${mode})`, parsed, true);
	check(`mode attribute (${mode})`, html.includes(`data-mode="${mode}"`), true);
	check(`slug attribute (${mode})`, html.includes('data-slug="my-site"'), true);
}

{
	let parsed = true;
	try {
		new Function(fleetPageHtml().match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "");
	} catch (e) {
		parsed = false;
		console.log(String(e));
	}
	check("fleet client script parses", parsed, true);
}

const cfg = { primary: "main", hosts: { "acme-x.workers.dev": "acme" }, wildcard: "example.com" };
check("exact host wins", siteUrl("acme", cfg), "https://acme-x.workers.dev");
check("wildcard otherwise", siteUrl("demo", cfg), "https://demo.example.com");
check("no hostname -> null", siteUrl("demo", { primary: "main" }), null);
console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
