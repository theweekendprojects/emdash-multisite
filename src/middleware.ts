import { after } from "emdash";
import { runAsSite } from "./dialect.ts";
import {
	ORG_CREATE_PATH,
	createSiteForOrg,
	parseCreatedOrg,
	readStatus,
	slugProblem,
} from "./orgs.ts";
import { isSiteId } from "./rewrite.ts";
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
 * On the control-plane (primary) site it also turns "create an organization"
 * into "create a site" (see orgs.ts) and serves
 * GET /api/multisite/sites/<slug> so a page can poll provisioning.
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
interface Ctx {
	url: URL;
	request: Request;
}

const STATUS_PREFIX = "/api/multisite/sites/";
const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** `POST /api/auth/organization/create`: reject an unusable slug before the org exists. */
async function guardOrgCreate(request: Request, primary: string): Promise<Response | null> {
	let body: { slug?: unknown } | null = null;
	try {
		body = (await request.clone().json()) as { slug?: unknown };
	} catch {
		return null; // not JSON: let Better Auth produce its own error
	}
	const problem = slugProblem(body?.slug, primary);
	return problem ? json({ code: "INVALID_SITE_ADDRESS", message: problem }, 400) : null;
}

export async function onRequest(context: Ctx, next: Next): Promise<Response> {
	const sites = sitesConfig();
	if (!sites) return next();
	const state = scopeState();
	state.primary = sites.primary;
	const site = resolveSite(context.url.hostname, sites);

	return runAsSite(site, async () => {
		if (site !== sites.primary) return next();
		const { pathname } = context.url;
		const { method } = context.request;

		if (method === "GET" && pathname.startsWith(STATUS_PREFIX)) {
			const slug = pathname.slice(STATUS_PREFIX.length);
			if (!isSiteId(slug)) return json({ code: "NOT_FOUND" }, 404);
			const status = await readStatus(slug);
			return status ? json(status, 200) : json({ code: "NOT_FOUND" }, 404);
		}

		if (method === "POST" && pathname === ORG_CREATE_PATH) {
			const rejected = await guardOrgCreate(context.request, sites.primary);
			if (rejected) return rejected;
			const response = await next();
			if (response.status === 200) {
				const org = parseCreatedOrg(await response.clone().json().catch(() => null));
				// Provisioning outlives the response: `after` uses the Worker's waitUntil.
				if (org) after(() => runAsSite(site, () => createSiteForOrg(org)));
			}
			return response;
		}

		return next();
	});
}
