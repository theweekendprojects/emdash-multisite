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
import { signUpOpen, switchTheme } from "./orgs.ts";
import { themeProblem } from "./rules.ts";
import { activeSite, scopeState } from "./scope.ts";
import { listSites } from "./fleet.ts";
import { runFleetAction } from "./fleet-actions.ts";
import { PURGE_FORM_ACTION, fleetBlocks, parseFleetAction } from "./fleet-blocks.ts";
import { isSiteId } from "./rewrite.ts";

const SWITCH_ACTION = "switch_theme";

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

	if (state.themes.length > 1) {
		blocks.push({ type: "divider" }, { type: "header", text: "Appearance" });
		blocks.push({
			type: "context",
			text: "Switching keeps all of your content. Anything the new theme does not show is hidden, and comes back if you switch back.",
		});
		if (sites.appUrl) {
			blocks.push({
				type: "actions",
				elements: [
					{
						type: "link" as const,
						label: "Browse themes as cards",
						target: { kind: "external" as const, url: `${sites.appUrl}/sites/${state.slug}/appearance` },
						appearance: "secondary" as const,
					},
				],
			});
		}
		const others = state.themes.filter((t) => !t.current);
		for (const t of others) {
			const parts = [t.adds.length ? `adds ${t.adds.join(", ")}` : "", t.hides.length ? `hides ${t.hides.join(", ")}` : ""].filter(Boolean);
			blocks.push({ type: "context", text: `${t.name}: ${t.description}${parts.length ? ` (${parts.join("; ")})` : ""}` });
		}
		blocks.push({
			type: "form",
			block_id: "theme",
			fields: [
				{
					type: "select",
					action_id: "theme",
					label: "Theme",
					options: state.themes.map((t) => ({ label: t.current ? `${t.name} (current)` : t.name, value: t.id })),
					initial_value: state.current,
				},
				{ type: "toggle", action_id: "sample", label: "Add sample content for any new sections", initial_value: false },
			],
			submit: { label: "Switch theme", action_id: SWITCH_ACTION },
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
					if (interaction.type === "form_submit" && interaction.action_id === SWITCH_ACTION) {
						const sites = sitesConfig();
						const theme = interaction.values?.theme;
						const issue = themeProblem(theme, sites?.themes);
						if (!sites || issue || typeof theme !== "string") {
							return buildPage({ message: issue ?? "Choose a theme.", type: "error" });
						}
						const slug = activeSite();
						const current = (await appearanceState(slug, sites))?.current;
						try {
							await switchTheme(sites, slug, theme, { includeContent: interaction.values?.sample === true });
						} catch (error) {
							console.error(`[multisite] switching "${slug}" to "${theme}" failed:`, error);
							return buildPage({ message: "Could not switch the theme. Try again.", type: "error" });
						}
						return buildPage({
							message: theme === current ? "Theme re-applied." : "Theme switched. It shows within a minute.",
							type: "success",
						});
					}
					return buildPage();
				},
			},
		},
	});
}
export default createPlugin;
