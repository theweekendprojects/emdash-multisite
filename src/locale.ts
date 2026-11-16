/**
 * Sets this deployment's locale for src/i18n.ts, once per isolate: `SitesConfig.locale`, else the
 * EmDash/Astro i18n default locale, else English. Build-time inputs only, never the request, so
 * every request of a deployment renders in the same language and no cache key changes.
 */
// @ts-ignore - Astro virtual module (i18n is undefined when the host configures no i18n)
import { i18n } from "astro:config/client";
import { sitesConfig } from "./config.ts";
import { getLocale, resolveLocale, setLocale, type Locale } from "./i18n.ts";

let done = false;

export function initLocale(): Locale {
	if (!done) {
		setLocale(resolveLocale(sitesConfig()?.locale, (i18n as { defaultLocale?: string } | undefined)?.defaultLocale));
		done = true;
	}
	return getLocale();
}
