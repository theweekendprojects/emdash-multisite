/**
 * The fleet as an EmDash admin page (Block Kit), for staff on the control plane.
 * Pure: takes the site list, returns blocks; no database, so a plain-Node self-check covers it
 * (scripts/fleet.selfcheck.ts). The actions themselves run in fleet-actions.ts.
 */
import { isSiteId } from "./rewrite.ts";

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

const LABELS: Record<FleetAction, string> = {
	suspend: "Suspend",
	resume: "Resume",
	delete: "Delete (kept 14 days)",
	restore: "Restore",
	retry: "Retry setup",
	backup: "Back up now",
	purge: "Purge",
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
		{ type: "header", text: "Fleet" },
		{
			type: "stats",
			items: [
				{ label: "Sites", value: sites.length - deleted.length },
				{ label: "Needs attention", value: attention, trend: attention ? "down" : "neutral" },
				{ label: "Suspended", value: count((s) => s.state === "suspended") },
				{ label: "Deleted, not purged", value: deleted.length },
				{ label: "Users on sites", value: sites.reduce((n, s) => n + s.userCount, 0) },
			],
		},
	];
	blocks.push({
		type: "table",
		page_action_id: "fleet_page",
		empty_text: "No sites yet.",
		columns: [
			{ key: "site", label: "Site", format: "code" },
			{ key: "owner", label: "Owner" },
			{ key: "status", label: "Setup", format: "badge" },
			{ key: "state", label: "State", format: "badge" },
			{ key: "users", label: "Users", format: "number" },
			{ key: "created", label: "Created", format: "relative_time" },
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
				label: "Actions",
				items: actionsFor(s).map((a) => ({ label: LABELS[a], value: a })),
			},
		})),
	});
	if (deleted.length) {
		blocks.push(
			{ type: "divider" },
			{ type: "header", text: "Purge" },
			{
				type: "context",
				text: "Deleted sites are destroyed automatically after the grace period. Purging now removes the tables, files, backups and organization for good.",
			},
			{
				type: "form",
				block_id: "purge",
				fields: [
					{ type: "select", action_id: "slug", label: "Deleted site", options: deleted.map((s) => ({ label: s.slug, value: s.slug })), initial_value: deleted[0]!.slug },
					{ type: "toggle", action_id: "confirm", label: "I understand this cannot be undone", initial_value: false },
				],
				submit: { label: "Purge now", action_id: PURGE_FORM_ACTION },
			},
		);
	}
	return blocks;
}
