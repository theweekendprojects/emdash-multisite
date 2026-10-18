/**
 * Run a fleet action picked on the control plane's Site page (see fleet-blocks.ts). Same rules as the
 * HTTP routes in middleware.ts: state changes go through `transition`, purge needs a deleted site.
 * Slow work (a purge drops ~90 tables, a retry may migrate and seed) continues after the response.
 */
import { after } from "emdash";
import { backupSite } from "./backup.ts";
import { runAsSite } from "./dialect.ts";
import type { FleetAction } from "./fleet-blocks.ts";
import { reconcile } from "./orgs.ts";
import { purgeSite } from "./purge.ts";
import { purgeSiteCache } from "./edge-cache.ts";
import { readSiteState, writeSiteState } from "./registry.ts";
import { transition, type StateAction } from "./rules.ts";
import { scopeState } from "./scope.ts";
import type { SitesConfig } from "./sites.ts";

const STATE_ACTIONS = new Set<FleetAction>(["suspend", "resume", "delete", "restore"]);

export async function runFleetAction(sites: SitesConfig, slug: string, action: FleetAction): Promise<{ ok: boolean; message: string }> {
	const primary = scopeState().primary;
	if (slug === primary) return { ok: false, message: "The control plane is not managed here." };
	if (STATE_ACTIONS.has(action)) {
		const result = transition(await readSiteState(slug), action as StateAction, { staff: true, owner: false });
		if (!result.ok) return { ok: false, message: `Cannot ${action} "${slug}" in its current state.` };
		await writeSiteState(slug, result.next ? { state: result.next, at: new Date().toISOString(), reason: `${action} from the fleet page` } : null);
		await purgeSiteCache(slug);
		return { ok: true, message: `${slug}: ${action} done.` };
	}
	if (action === "backup") {
		const { bytes } = await runAsSite(primary, () => backupSite(slug));
		return { ok: true, message: `${slug}: backed up (${Math.round(bytes / 1024)} KB).` };
	}
	if (action === "retry") {
		after(() => runAsSite(primary, () => reconcile(sites, slug)).then(() => undefined));
		return { ok: true, message: `${slug}: setup restarted. Reload in a minute.` };
	}
	if (action === "purge") {
		if ((await readSiteState(slug))?.state !== "deleted") return { ok: false, message: `"${slug}" is not deleted.` };
		after(() => runAsSite(primary, () => purgeSite(slug)).then(() => undefined));
		return { ok: true, message: `${slug}: purge started. It takes about a minute.` };
	}
	return { ok: false, message: "Unknown action." };
}
