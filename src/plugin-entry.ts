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
import { appearanceState } from "./console.ts";
import { sitesConfig } from "./config.ts";
import { PLUGIN_ID, PLUGIN_PAGE_PATH, PLUGIN_VERSION } from "./plugin.ts";
import { signUpOpen } from "./orgs.ts";
import { activeSite, scopeState } from "./scope.ts";
import { listSites } from "./fleet.ts";
import { runFleetAction } from "./fleet-actions.ts";
import { PURGE_FORM_ACTION, fleetBlocks, parseFleetAction } from "./fleet-blocks.ts";
import { isSiteId } from "./rewrite.ts";


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
	const blocks: unknown[] = [{ type: "header", text: "Site" }];

	if (!sites || !state) {
		blocks.push({
			type: "context",
			text: `This site is not managed by the multi-site platform (site "${slug}", ${sites ? (sites.themes ? "no matching organization" : "no themes configured") : "no multisite config"}).`,
		});
		return { blocks, ...(toast ? { toast } : {}) };
	}

	blocks.push({ type: "context", text: `${state.name} (${state.slug})` });
	blocks.push({
		type: "context",
		text: `Public sign-up is ${(await signUpOpen(slug)) ? "ON: visitors can create an account" : "OFF: only people you add can sign in"}. Change it in Settings, Better Auth, "Allow new sign-ups".`,
	});

	if (state.themes.length > 1 && sites.appUrl) {
		// One home for theme switching: the Sites tab of the account page (Better Auth UI).
		const current = state.themes.find((t) => t.current);
		blocks.push({ type: "divider" }, { type: "header", text: "Appearance" });
		blocks.push({ type: "context", text: `Theme: ${current?.name ?? state.current}. Switching keeps all of your content; anything the new theme does not show is hidden and comes back if you switch back.` });
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "link" as const,
					label: "Change theme",
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
		blocks.push({ type: "divider" }, { type: "header", text: "Account" });
		blocks.push({ type: "actions", elements: [link("/account/sites", "My sites"), link("/account", "Account")] });
	}
	return { blocks, ...(toast ? { toast } : {}) };
}

export function createPlugin() {
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		admin: { pages: [{ path: PLUGIN_PAGE_PATH, label: "Site", icon: "globe" }] },
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
								return fleetPage({ message: "Pick a site and tick the box to purge.", type: "error" });
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
