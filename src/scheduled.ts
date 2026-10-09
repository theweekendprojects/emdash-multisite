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
import { readAllStatuses, warm } from "./registry.ts";
import { scopeState } from "./scope.ts";

type Scheduled = (controller: unknown, env: unknown, ctx: { waitUntil(p: Promise<unknown>): void }) => unknown;

/** Sites that should run: the primary, then every site whose provisioning finished. */
export async function sitesToSweep(): Promise<string[]> {
	await warm();
	const ready = [...(await readAllStatuses())].filter(([, s]) => s.status === "ready").map(([slug]) => slug);
	return [scopeState().primary, ...ready.sort()];
}

export function perSiteScheduled<T extends Scheduled>(base: T): T {
	const wrapped: Scheduled = (controller, env, ctx) => {
		ctx.waitUntil(
			(async () => {
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
