import { runAsSite } from "./dialect.ts";
import { scopeState } from "./scope.ts";
import { resolveSite, type SitesConfig } from "./sites.ts";

/**
 * Outer middleware: runs BEFORE EmDash's own, and wraps the whole request in
 * the site its hostname maps to.
 *
 * Why it exists: EmDash reads its runtime and caches at the very top of a
 * request, before the per-site database handle exists. Setting the site here
 * means every per-site cache and the runtime resolve to the right site from the
 * first line of the request.
 *
 * Wire it through EmDash's supported hook:
 *   emdash({ middleware: { outer: "emdash-multisite/middleware" } })
 */

// Set at build time by withSites(), carried in the config baked into the Worker.
// @ts-ignore - virtual module provided by EmDash's integration
import emdashConfig from "virtual:emdash/config";

interface WithSites {
	database?: { config?: { sites?: SitesConfig } };
}

function sitesConfig(): SitesConfig | undefined {
	return (emdashConfig as WithSites).database?.config?.sites;
}

type Next = () => Promise<Response>;

export async function onRequest(context: { url: URL }, next: Next): Promise<Response> {
	const sites = sitesConfig();
	if (!sites) return next();
	scopeState().primary = sites.primary;
	return runAsSite(resolveSite(context.url.hostname, sites), next);
}
