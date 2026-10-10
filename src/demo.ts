/**
 * Where each theme's public demo lives. The template site `tpl-<theme>` is served like any other site
 * (a `hosts` entry, or `tpl-<theme>.<wildcard>`), read-only (see `demoGuard`). A theme has a demo once its
 * template is complete, so the pickers only link to demos that exist.
 */
import { hasTemplate } from "./clone-run.ts";
import { templateId } from "./rules.ts";
import { siteUrl, type SitesConfig } from "./sites.ts";

const TTL_MS = 60_000;
let memo: { at: number; urls: Record<string, string> } | undefined;

/** Theme id -> demo URL, for the themes that have a complete template and an address. */
export async function demoUrls(sites: SitesConfig): Promise<Record<string, string>> {
	if (memo && Date.now() - memo.at < TTL_MS) return memo.urls;
	const urls: Record<string, string> = {};
	for (const theme of Object.keys(sites.themes ?? {})) {
		const url = siteUrl(templateId(theme), sites);
		if (url && (await hasTemplate(theme))) urls[theme] = url;
	}
	memo = { at: Date.now(), urls };
	return urls;
}
