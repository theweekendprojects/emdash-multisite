/**
 * Runtime of the multisite admin plugin: one Block Kit page, "Site", in each
 * site's own EmDash admin.
 *
 * - **Appearance**: pick another theme for THIS site (additive, nothing is deleted;
 *   see `switchTheme`). The site is the one the request is for, so the page works
 *   unchanged on every tenant and on the control plane.
 * - **Account**: links back to the app (account, my sites).
 *
 * The route is admin-only (`plugins:manage`), which on a tenant means its owner
 * and any admins they appoint, and nobody else.
 */
import { definePlugin } from "emdash";
import { purgeSiteCache } from "./edge-cache.ts";
import { appearanceState } from "./console.ts";
import { sitesConfig } from "./config.ts";
import { PLUGIN_ID, PLUGIN_PAGE_PATH, PLUGIN_VERSION } from "./plugin.ts";
import { signUpOpen } from "./orgs.ts";
import { activeSite, scopeState } from "./scope.ts";
import { listSites } from "./fleet.ts";
import { runFleetAction } from "./fleet-actions.ts";
import { PURGE_FORM_ACTION, fleetBlocks, parseFleetAction } from "./fleet-blocks.ts";
import { isSiteId } from "./rewrite.ts";
import { t } from "./i18n.ts";


interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
interface Page {
	blocks: unknown[];
	toast?: { message: string; type: "info" | "success" | "error" };
}

/** The control plane's Site page is the fleet: every site, with staff actions. */
async function fleetPage(toast?: Page["toast"]): Promise<Page> {
	return { blocks: fleetBlocks(await listSites(), scopeState().primary), ...(toast ? { toast } : {}) };
}
async function buildPage(toast?: Page["toast"]): Promise<Page> {
	const sites = sitesConfig();
	const slug = activeSite();
	if (slug === scopeState().primary) return fleetPage(toast);
	const state = sites ? await appearanceState(slug, sites) : null;
	const blocks: unknown[] = [{ type: "header", text: t("sitePage.title") }];

	if (!sites || !state) {
		blocks.push({
			type: "context",
			text: t("sitePage.unmanaged", { slug, reason: t(sites ? (sites.themes ? "sitePage.unmanaged.noOrg" : "sitePage.unmanaged.noThemes") : "sitePage.unmanaged.noConfig") }),
		});
		return { blocks, ...(toast ? { toast } : {}) };
	}

	blocks.push({ type: "context", text: t("sitePage.identity", { name: state.name, slug: state.slug }) });
	blocks.push({
		type: "context",
		text: t("sitePage.signup", { state: t((await signUpOpen(slug)) ? "sitePage.signup.on" : "sitePage.signup.off") }),
	});

	if (state.themes.length > 1 && sites.appUrl) {
		// One home for theme switching: the Sites tab of the account page (Better Auth UI).
		const current = state.themes.find((t) => t.current);
		blocks.push({ type: "divider" }, { type: "header", text: t("sitePage.appearance.title") });
		blocks.push({ type: "context", text: t("sitePage.appearance.text", { name: current?.name ?? state.current }) });
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "link" as const,
					label: t("sitePage.appearance.change"),
					target: { kind: "external" as const, url: `${sites.appUrl}/account/sites?appearance=${state.slug}` },
					appearance: "secondary" as const,
				},
			],
		});
	}
	if (sites.appUrl) {
		const link = (path: string, label: string) => ({
			type: "link" as const,
			label,
			target: { kind: "external" as const, url: `${sites.appUrl}${path}` },
			appearance: "secondary" as const,
		});
		blocks.push({ type: "divider" }, { type: "header", text: t("sitePage.account.title") });
		blocks.push({ type: "actions", elements: [link("/account/sites", t("sitePage.account.sites")), link("/account", t("sitePage.account.account"))] });
	}
	return { blocks, ...(toast ? { toast } : {}) };
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: ["read:content"],
		// Anything that changes a public page drops this site's cached pages (purge by `site:<slug>`, see edge-cache.ts).
		// Draft autosaves of a published entry only stage a draft revision (`draftRevisionId` set), so they must NOT purge: the
		// purge budget is tiny and shared by every tenant. Edits to menus, widgets, settings, taxonomies and so on have no hook;
		// the middleware purges those after the successful admin write (see watchEdits in middleware.ts).
		hooks: {
			"content:afterPublish": { handler: async () => void (await purgeSiteCache(activeSite())) },
			"content:afterUnpublish": { handler: async () => void (await purgeSiteCache(activeSite())) },
			"content:afterDelete": { handler: async () => void (await purgeSiteCache(activeSite())) },
			"content:afterSave": {
				handler: async (event: { content?: Record<string, unknown> }) => {
					// Collections without revisions write the live row directly.
					if (event.content?.status === "published" && !event.content.draftRevisionId) await purgeSiteCache(activeSite());
				},
			},
			"byline:afterSave": { handler: async () => void (await purgeSiteCache(activeSite())) },
			"byline:afterDelete": { handler: async () => void (await purgeSiteCache(activeSite())) },
		},
		admin: { pages: [{ path: PLUGIN_PAGE_PATH, label: t("sitePage.title"), icon: "globe" }] },
		routes: {
			admin: {
				// Admin-only: changing the theme changes the whole public site.
				permission: "plugins:manage",
				handler: async (routeCtx: { input?: unknown }): Promise<Page> => {
					const interaction = (routeCtx.input ?? { type: "page_load" }) as Interaction;
					const sitesConfigured = sitesConfig();
					if (sitesConfigured && activeSite() === scopeState().primary) {
						// Control plane: row menu actions and the purge form. (Only reachable with `plugins:manage`, i.e. staff.)
						const row = interaction.type === "block_action" ? parseFleetAction(interaction.action_id, interaction.value) : null;
						if (row) {
							const r = await runFleetAction(sitesConfigured, row.slug, row.action);
							return fleetPage({ message: r.message, type: r.ok ? "success" : "error" });
						}
						if (interaction.type === "form_submit" && interaction.action_id === PURGE_FORM_ACTION) {
							const slug = interaction.values?.slug;
							if (typeof slug !== "string" || !isSiteId(slug) || interaction.values?.confirm !== true) {
								return fleetPage({ message: t("fleet.purge.missing"), type: "error" });
							}
							const r = await runFleetAction(sitesConfigured, slug, "purge");
							return fleetPage({ message: r.message, type: r.ok ? "success" : "error" });
						}
						return fleetPage();
					}
					return buildPage();
				},
			},
		},
	});
}
export default createPlugin;
