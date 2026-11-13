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
import { t } from "./i18n.ts";
import { readSiteState, writeSiteState } from "./registry.ts";
import { transition, type StateAction } from "./rules.ts";
import { scopeState } from "./scope.ts";
import type { SitesConfig } from "./sites.ts";

const STATE_ACTIONS = new Set<FleetAction>(["suspend", "resume", "delete", "restore"]);

export async function runFleetAction(sites: SitesConfig, slug: string, action: FleetAction): Promise<{ ok: boolean; message: string }> {
	const primary = scopeState().primary;
	if (slug === primary) return { ok: false, message: t("fleet.result.controlPlane") };
	if (STATE_ACTIONS.has(action)) {
		const result = transition(await readSiteState(slug), action as StateAction, { staff: true, owner: false });
		if (!result.ok) return { ok: false, message: t(`fleet.result.refused.${action as StateAction}`, { slug }) };
		await writeSiteState(slug, result.next ? { state: result.next, at: new Date().toISOString(), reason: `${action} from the fleet page` } : null);
		await purgeSiteCache(slug);
		return { ok: true, message: t(`fleet.result.done.${action as StateAction}`, { slug }) };
	}
	if (action === "backup") {
		const { bytes } = await runAsSite(primary, () => backupSite(slug));
		return { ok: true, message: t("fleet.result.backedUp", { slug, kb: Math.round(bytes / 1024) }) };
	}
	if (action === "retry") {
		after(() => runAsSite(primary, () => reconcile(sites, slug)).then(() => undefined));
		return { ok: true, message: t("fleet.result.retry", { slug }) };
	}
	if (action === "purge") {
		if ((await readSiteState(slug))?.state !== "deleted") return { ok: false, message: t("fleet.result.notDeleted", { slug }) };
		after(() => runAsSite(primary, () => purgeSite(slug)).then(() => undefined));
		return { ok: true, message: t("fleet.result.purge", { slug }) };
	}
	return { ok: false, message: t("fleet.result.unknown") };
}
