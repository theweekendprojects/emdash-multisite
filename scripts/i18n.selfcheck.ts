/** Checks for the message catalog (src/i18n.ts): `node --no-warnings scripts/i18n.selfcheck.ts` */
import { readdirSync, readFileSync } from "node:fs";
import { LOCALES, catalogFor, escapeHtml, getLocale, matchLocale, messageKeys, messagesFor, resolveLocale, setLocale, t, tHtml, tn, type MessageKey } from "../src/i18n.ts";
import { assertSitesConfig } from "../src/sites.ts";
let failed = 0;
const check = (name: string, got: unknown, want: unknown) => {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failed++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`}`);
};

// ---- helpers ----
check("t: plain message", t("fleet.title"), "Fleet");
check("t: named params", t("fleet.result.backedUp", { slug: "acme", kb: 85 }), "acme: backed up (85 KB).");
check("t: a missing param leaves its placeholder", t("fleet.result.backedUp", { slug: "acme" }), "acme: backed up ({kb} KB).");
check("tn: one / other", [tn("api.create.limit", 1, { max: 1 }), tn("api.create.limit", 3, { max: 3 })], ["You can own up to 1 site.", "You can own up to 3 sites."]);
check("tn: zero is plural in English", tn("api.purgeNotDue", 0, { days: 0 }), "Deleted sites are kept 0 days.");
check("tHtml: params are escaped", tHtml("demo.text", { name: `<b>"x"</b>` }), "This is a demo of the &#60;b&#62;&#34;x&#34;&#60;/b&#62; theme.");
check("tHtml: the message is escaped too", tHtml("api.address.reserved", { slug: "a" }), "&#34;a&#34; is reserved. Choose another address.");
check("escapeHtml: same encoding as the former demo banner helper", escapeHtml(`&<>"'`), "&#38;&#60;&#62;&#34;&#39;");

// ---- the client slice ----
const client = messagesFor("console.");
check("messagesFor: only the prefix", Object.keys(client).every((k) => k.startsWith("console.")), true);
check("messagesFor: the whole prefix", Object.keys(client).length, messageKeys().filter((k) => k.startsWith("console.")).length);
check("messagesFor: nothing else from the catalog", Object.keys(client).some((k) => k.startsWith("account.") || k.startsWith("api.")), false);

// ---- catalog shape ----
const keys = messageKeys();
const orphanPlurals = keys.filter((k) => (k.endsWith(".one") && !keys.includes(`${k.slice(0, -4)}.other` as MessageKey)) || (k.endsWith(".other") && !keys.includes(`${k.slice(0, -6)}.one` as MessageKey)));
check("every plural has both forms", orphanPlurals, []);
check("no empty message", keys.filter((k) => !t(k).trim()), []);
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
check(
	"plural forms take the same params",
	keys.filter((k) => k.endsWith(".one")).filter((k) => JSON.stringify(placeholders(t(k))) !== JSON.stringify(placeholders(t(`${k.slice(0, -4)}.other` as MessageKey)))),
	[],
);

// ---- every key the code names exists, and every message is used ----
// Keys are written as string literals; a few are built from a literal prefix (status, role, step and fleet action names).
const NAMESPACES = /["'`]((?:console|account|fleet|sitePage|status|handoff|demo|links|api)\.[\w.]+?)(\.?)["'`$]/g;
const srcDir = new URL("../src/", import.meta.url);
const used = new Set<string>();
const prefixes = new Set<string>();
for (const file of readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !/^i18n(-\w+)?\.ts$/.test(f))) {
	for (const m of readFileSync(new URL(file, srcDir), "utf8").matchAll(NAMESPACES)) (m[2] ? prefixes : used).add(m[2] ? `${m[1]}.` : m[1]!);
}
const known = new Set<string>(keys);
const pluralBases = new Set(keys.filter((k) => k.endsWith(".one")).map((k) => k.slice(0, -4)));
check("every key used in src/ exists", [...used].filter((k) => !known.has(k) && !pluralBases.has(k) && ![...prefixes].some((p) => `${k}.` === p)), []);
const covered = (k: string) => used.has(k) || pluralBases.has(k.replace(/\.(one|other)$/, "")) && used.has(k.replace(/\.(one|other)$/, "")) || [...prefixes].some((p) => k.startsWith(p));
check("every message is used", keys.filter((k) => !covered(k)), []);

// ---- locales ----
check("locales: en and fr", LOCALES, ["en", "fr"]);
check("matchLocale: tags and case", ["fr", "fr-FR", "FR_fr", " en-GB ", "de", "", null, 3].map(matchLocale), ["fr", "fr", "fr", "en", null, null, null, null]);
check("resolveLocale: config wins, then the i18n default, then English", [resolveLocale("fr", "en"), resolveLocale(undefined, "fr-FR"), resolveLocale("xx", "de"), resolveLocale(undefined, undefined)], ["fr", "fr", "en", "en"]);
check("English is the default", getLocale(), "en");
for (const locale of LOCALES) {
	const messages = catalogFor(locale);
	check(`${locale}: same keys as English, in the same order`, Object.keys(messages), keys);
	check(`${locale}: same placeholders as English`, keys.filter((k) => JSON.stringify(placeholders(messages[k])) !== JSON.stringify(placeholders(t(k)))), []);
	check(`${locale}: no empty message`, keys.filter((k) => !messages[k].trim()), []);
}
check("fr: no straight apostrophe or quote", keys.filter((k) => /['"]/.test(catalogFor("fr")[k])), []);
setLocale("fr");
check("setLocale switches t", t("fleet.action.purge"), "Purger");
check("fr plural: 0 and 1 are singular", [tn("api.purgeNotDue", 0, { days: 0 }), tn("api.purgeNotDue", 1, { days: 1 }), tn("api.purgeNotDue", 2, { days: 2 })], ["Les sites supprimés sont conservés 0 jour.", "Les sites supprimés sont conservés 1 jour.", "Les sites supprimés sont conservés 2 jours."]);
check("fr: the client slice follows the locale", messagesFor("console.")["console.nav.sites"], "Mes sites");
setLocale("en");
check("back to English", t("fleet.action.purge"), "Purge");
const configError = (locale: string) => { try { assertSitesConfig({ primary: "app", locale }); return null; } catch (e) { return (e as Error).message; } };
check("config: a locale without a catalog is refused", [configError("fr-FR"), configError("de")], [null, '[multisite] locale "de" has no catalog (available: en, fr)']);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
