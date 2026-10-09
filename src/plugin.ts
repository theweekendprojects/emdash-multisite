import type { PluginDescriptor } from "emdash";

export const PLUGIN_ID = "multisite";
export const PLUGIN_VERSION = "0.1.0";
/** Sidebar page path inside the site's admin: `/_emdash/admin/plugins/multisite/site`. */
export const PLUGIN_PAGE_PATH = "/site";

/**
 * Native EmDash plugin that adds a **Site** page to every site's own admin: change
 * the theme (Appearance) and jump back to the account area. Register it next to
 * the database wrapper:
 *
 * ```ts
 * emdash({ database: withSites(...), plugins: [multisitePlugin()] })
 * ```
 *
 * Runtime lives in `plugin-entry.ts` (loaded only on the server).
 */
export function multisitePlugin(): PluginDescriptor {
	return {
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		format: "native",
		entrypoint: "emdash-multisite/plugin-entry",
	};
}
