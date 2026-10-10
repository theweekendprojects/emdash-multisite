/**
 * Cron fan-out. EmDash's scheduled handler publishes due scheduled content and
 * runs plugin cron for ONE site: whichever is ambient, which in a cron trigger
 * (no request, no hostname) is the primary. Wrap it so every ready site gets
 * its turn:
 *
 *   import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
 *   import { perSiteScheduled } from "emdash-multisite/scheduled";
 *   export default { ...handler, scheduled: perSiteScheduled(createScheduledHandler()) };
 *
 * ponytail: sites run one after another inside a single trigger, so a tick takes
 * roughly (sites x per-site sweep). Fine for hundreds of mostly idle sites; the
 * upgrade path is a Queue with one message per site, fed by this same loop.
 */
import { runAsSite } from "./dialect.ts";
import { sitesConfig } from "./config.ts";
import { reconcile } from "./orgs.ts";
import { backupSite, readLastBackups } from "./backup.ts";
import { mediaBucket } from "./media-bucket.ts";
import { syncRecentPasswords } from "./passwords.ts";
import { purgeSite } from "./purge.ts";
import { readAllStates, readAllStatuses, warm } from "./registry.ts";
import { DEFAULT_DELETE_GRACE_DAYS, backupDue, isPurgeDue, mayStartAnother } from "./rules.ts";
import { scopeState } from "./scope.ts";

type Scheduled = (controller: unknown, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) => unknown;

/**
 * Sites that should run: the primary, then every site whose provisioning finished
 * and that is neither suspended nor deleted. Skipping the latter two matters: waking
 * a site's runtime runs its migrations, which would re-create the tables of a site
 * that is being purged.
 */
export async function sitesToSweep(): Promise<string[]> {
	await warm();
	const inactive = await readAllStates();
	const ready = [...(await readAllStatuses())].filter(([slug, s]) => s.status === "ready" && !inactive.has(slug)).map(([slug]) => slug);
	return [scopeState().primary, ...ready.sort()];
}

export function perSiteScheduled<T extends Scheduled>(base: T): T {
	const wrapped: Scheduled = (controller, env, ctx) => {
		ctx.waitUntil(
			(async () => {
				// A cron run can start in a fresh isolate that has served no request, so the database wrapper does not exist yet.
				// Without this every task below failed with "database not initialised yet" (purge, backup, password sync, reconcile).
				try {
					await warm();
				} catch (error) {
					console.error("[multisite] could not open the database for the cron run:", error);
				}
				// Destroy at most one site whose delete grace period is over (a purge is many DROPs).
				try {
					const grace = sitesConfig()?.deleteGraceDays ?? DEFAULT_DELETE_GRACE_DAYS;
					const due = [...(await readAllStates())].find(([, st]) => isPurgeDue(st, grace, Date.now()));
					if (due) await runAsSite(scopeState().primary, () => purgeSite(due[0]));
				} catch (error) {
					console.error("[multisite] purge failed:", error);
				}
				// Back up at most one ready site that has no backup from the last day. Skipped without R2.
				try {
					const last = await readLastBackups();
					const inactive = await readAllStates();
					const due = [...(await readAllStatuses())]
						.find(([slug, st]) => st.status === "ready" && !inactive.has(slug) && backupDue(last.get(slug), Date.now()));
					if (due && (await mediaBucket())) await runAsSite(scopeState().primary, () => backupSite(due[0]));
				} catch (error) {
					console.error("[multisite] backup failed:", error);
				}
				// Safety net for password changes whose immediate sync was cut off.
				try {
					await runAsSite(scopeState().primary, () => syncRecentPasswords(10 * 60_000));
				} catch (error) {
					console.error("[multisite] password sync failed:", error);
				}
				// Finish one site whose provisioning died and that nobody is watching.
				try {
					const cfg = sitesConfig();
					if (cfg) {
						// Several stuck sites per tick (template clones take seconds), not one: a bad deploy can strand dozens.
						const t0 = Date.now();
						for (let done = 0; mayStartAnother(done, Date.now() - t0); done++) {
							if (!(await runAsSite(scopeState().primary, () => reconcile(cfg))).length) break;
						}
					}
				} catch (error) {
					console.error("[multisite] reconcile failed:", error);
				}
				for (const site of await sitesToSweep()) {
					// The base handler hands its work to ctx.waitUntil; collect it so each
					// site finishes before the next starts, and one failing site does not
					// stop the rest.
					const pending: Promise<unknown>[] = [];
					try {
						await runAsSite(site, async () => {
							await base(controller, env, { ...ctx, waitUntil: (p) => void pending.push(p) });
						});
					} catch (error) {
						console.error(`[multisite] scheduled sweep for "${site}" failed:`, error);
					}
					await Promise.allSettled(pending);
				}
			})(),
		);
	};
	return wrapped as T;
}
