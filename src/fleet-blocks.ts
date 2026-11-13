/**
 * The fleet as an EmDash admin page (Block Kit), for staff on the control plane.
 * Pure: takes the site list, returns blocks; no database, so a plain-Node self-check covers it
 * (scripts/fleet.selfcheck.ts). The actions themselves run in fleet-actions.ts.
 */
import { isSiteId } from "./rewrite.ts";
import { t, type MessageKey } from "./i18n.ts";

/** What the page needs to know about a site (a subset of `FleetSite`). */
export interface FleetRow {
	slug: string;
	name: string;
	ownerEmail: string | null;
	status: "provisioning" | "ready" | "failed" | "unknown";
	state: "active" | "suspended" | "deleted";
	createdAt: string | null;
	userCount: number;
}

export type FleetAction = "suspend" | "resume" | "delete" | "restore" | "retry" | "backup" | "purge";
const ACTIONS: ReadonlySet<string> = new Set<FleetAction>(["suspend", "resume", "delete", "restore", "retry", "backup", "purge"]);
export const ROW_ACTION_PREFIX = "fleet:";
export const PURGE_FORM_ACTION = "fleet_purge";

const LABELS: Record<FleetAction, MessageKey> = {
	suspend: "fleet.action.suspend",
	resume: "fleet.action.resume",
	delete: "fleet.action.delete",
	restore: "fleet.action.restore",
	retry: "fleet.action.retry",
	backup: "fleet.action.backup",
	purge: "fleet.action.purge",
};

/** Actions that make sense for a site in its current state. Purge is not here: it has its own confirmed form. */
export function actionsFor(site: FleetRow): FleetAction[] {
	if (site.state === "deleted") return ["restore"];
	if (site.state === "suspended") return ["resume", "backup", "delete"];
	return site.status === "ready" ? ["suspend", "backup", "delete"] : ["retry", "suspend", "delete"];
}

/** Read a menu click: `fleet:<slug>` + the chosen value. `null` for anything else. */
export function parseFleetAction(actionId: unknown, value: unknown): { slug: string; action: FleetAction } | null {
	if (typeof actionId !== "string" || !actionId.startsWith(ROW_ACTION_PREFIX) || typeof value !== "string") return null;
	const slug = actionId.slice(ROW_ACTION_PREFIX.length);
	if (!isSiteId(slug) || !ACTIONS.has(value) || value === "purge") return null;
	return { slug, action: value as FleetAction };
}

export function fleetBlocks(all: FleetRow[], primary: string): unknown[] {
	const sites = all.filter((s) => s.slug !== primary);
	const count = (f: (s: FleetRow) => boolean) => sites.filter(f).length;
	const deleted = sites.filter((s) => s.state === "deleted");
	const attention = count((s) => s.state === "active" && s.status !== "ready");
	const blocks: unknown[] = [
		{ type: "header", text: t("fleet.title") },
		{
			type: "stats",
			items: [
				{ label: t("fleet.stats.sites"), value: sites.length - deleted.length },
				{ label: t("fleet.stats.attention"), value: attention, trend: attention ? "down" : "neutral" },
				{ label: t("fleet.stats.suspended"), value: count((s) => s.state === "suspended") },
				{ label: t("fleet.stats.deleted"), value: deleted.length },
				{ label: t("fleet.stats.users"), value: sites.reduce((n, s) => n + s.userCount, 0) },
			],
		},
	];
	blocks.push({
		type: "table",
		page_action_id: "fleet_page",
		empty_text: t("fleet.table.empty"),
		columns: [
			{ key: "site", label: t("fleet.table.site"), format: "code" },
			{ key: "owner", label: t("fleet.table.owner") },
			{ key: "status", label: t("fleet.table.setup"), format: "badge" },
			{ key: "state", label: t("fleet.table.state"), format: "badge" },
			{ key: "users", label: t("fleet.table.users"), format: "number" },
			{ key: "created", label: t("fleet.table.created"), format: "relative_time" },
			{ key: "actions", label: "", format: "element" },
		],
		rows: sites.map((s) => ({
			site: s.slug,
			owner: s.ownerEmail ?? "-",
			status: s.status,
			state: s.state,
			users: s.userCount,
			created: s.createdAt ?? "",
			actions: {
				type: "menu",
				action_id: `${ROW_ACTION_PREFIX}${s.slug}`,
				label: t("fleet.table.actions"),
				items: actionsFor(s).map((a) => ({ label: t(LABELS[a]), value: a })),
			},
		})),
	});
	if (deleted.length) {
		blocks.push(
			{ type: "divider" },
			{ type: "header", text: t("fleet.purge.title") },
			{
				type: "context",
				text: t("fleet.purge.text"),
			},
			{
				type: "form",
				block_id: "purge",
				fields: [
					{ type: "select", action_id: "slug", label: t("fleet.purge.site"), options: deleted.map((s) => ({ label: s.slug, value: s.slug })), initial_value: deleted[0]!.slug },
					{ type: "toggle", action_id: "confirm", label: t("fleet.purge.confirm"), initial_value: false },
				],
				submit: { label: t("fleet.purge.submit"), action_id: PURGE_FORM_ACTION },
			},
		);
	}
	return blocks;
}
