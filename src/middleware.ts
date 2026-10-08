import { after } from "emdash";
import { runAsSite } from "./dialect.ts";
import { checkAddress, consoleState } from "./console.ts";
import { consolePageHtml } from "./console-page.ts";
import { isStaff, listSites } from "./fleet.ts";
import { fleetPageHtml } from "./fleet-page.ts";
import {
	ORG_CREATE_PATH,
	createSiteForOrg,
	parseCreatedOrg,
	pendingReconcile,
	readStatus,
	reconcile,
	slugProblem,
} from "./orgs.ts";
import { isEmailVerified, readOrgs, warm } from "./registry.ts";
import { DEFAULT_LIMITS, createProblem, type Limits } from "./rules.ts";
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
interface Session {
	get(key: string): unknown | Promise<unknown>;
}
interface Ctx {
	url: URL;
	request: Request;
	session?: Session;
}

const STATUS_PREFIX = "/api/multisite/sites/";
const RECONCILE_API = "/api/multisite/reconcile";
const FLEET_API = "/api/multisite/fleet";
const FLEET_PAGE = "/admin/fleet";
const html = (body: string, status: number) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

/** The signed-in EmDash user id, or null. Set by emdash-better-auth as session "user" = { id }. */
async function sessionUserId(ctx: Ctx): Promise<string | null> {
	try {
		const u = (await ctx.session?.get("user")) as { id?: string } | undefined;
		return u?.id ?? null;
	} catch {
		return null;
	}
}
const json = (body: unknown, status: number) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/**
 * `POST /api/auth/organization/create`: refuse before the org exists.
 * Bad address, unverified email, or over a limit. Anonymous callers fall
 * through so Better Auth answers 401 itself.
 */
async function guardOrgCreate(ctx: Ctx, primary: string, limits: Limits): Promise<Response | null> {
	let body: { slug?: unknown } | null = null;
	try {
		body = (await ctx.request.clone().json()) as { slug?: unknown };
	} catch {
		return null; // not JSON: let Better Auth produce its own error
	}
	const addressProblem = slugProblem(body?.slug, primary);
	if (addressProblem) return json({ code: "INVALID_SITE_ADDRESS", message: addressProblem }, 400);

	const userId = await sessionUserId(ctx);
	if (!userId) return null;
	const orgs = await readOrgs();
	const problem = createProblem(
		{
			userId,
			emailVerified: await isEmailVerified(userId),
			owned: orgs.filter((o) => o.ownerUserId === userId).length,
			total: orgs.length,
		},
		limits,
	);
	return problem ? json({ code: problem.code, message: problem.message }, problem.status) : null;
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
		if (pathname.startsWith("/api/multisite/") || pathname === FLEET_PAGE || pathname === ORG_CREATE_PATH) await warm();

		if (method === "GET" && pathname.startsWith(STATUS_PREFIX)) {
			const slug = pathname.slice(STATUS_PREFIX.length);
			if (!isSiteId(slug)) return json({ code: "NOT_FOUND" }, 404);
			const status = await readStatus(slug);
			return status ? json(status, 200) : json({ code: "NOT_FOUND" }, 404);
		}

		// Customer console. Pages need a session (shell only, no data); the JSON
		// is separately gated by the same session.
		if (method === "GET" && (pathname === "/sites" || pathname === "/sites/new")) {
			if (!(await sessionUserId(context))) {
				return Response.redirect(new URL(`/login?redirect=${encodeURIComponent(pathname)}`, context.url), 302);
			}
			return html(consolePageHtml(pathname === "/sites" ? "list" : "new"), 200);
		}
		if (method === "GET" && pathname === "/api/multisite/me") {
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			return json(await consoleState(userId, sites), 200);
		}
		if (method === "GET" && pathname === "/api/multisite/slug-check") {
			if (!(await sessionUserId(context))) return json({ code: "UNAUTHORIZED" }, 401);
			return json(await checkAddress(context.url.searchParams.get("slug"), sites.primary), 200);
		}

		// Retry one site's provisioning: its owner or staff. Idempotent, 202 = started.
		if (method === "POST" && pathname.startsWith(STATUS_PREFIX) && pathname.endsWith("/retry")) {
			const slug = pathname.slice(STATUS_PREFIX.length, -"/retry".length);
			if (!isSiteId(slug)) return json({ code: "NOT_FOUND" }, 404);
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			const org = (await readOrgs()).find((o) => o.slug === slug);
			if (!org) return json({ code: "NOT_FOUND" }, 404);
			if (org.ownerUserId !== userId && !(await isStaff(userId))) return json({ code: "FORBIDDEN" }, 403);
			if ((await pendingReconcile(slug)).length === 0) return json({ code: "NOT_NEEDED" }, 409);
			after(async () => void (await runAsSite(site, () => reconcile(slug))));
			return json({ retrying: true }, 202);
		}

		// Staff: re-run the next stuck site (failed, or provisioning that died). One per call; call again for the next.
		if (method === "POST" && pathname === RECONCILE_API) {
			if (!(await isStaff(await sessionUserId(context)))) return json({ code: "FORBIDDEN" }, 403);
			const slugs = await pendingReconcile();
			if (slugs.length) after(async () => void (await runAsSite(site, () => reconcile())));
			return json({ pending: slugs, started: slugs[0] ?? null }, 202);
		}

		// Fleet view — staff only (role 50 on the control plane). The keys to the
		// whole fleet, so the gate is the point: never reachable by a tenant admin
		// or an anonymous visitor.
		if (method === "GET" && pathname === FLEET_API) {
			if (!(await isStaff(await sessionUserId(context)))) return json({ code: "FORBIDDEN" }, 403);
			return json({ sites: await listSites() }, 200);
		}

		// The dashboard shell. The shell itself is harmless (no data), but gate it
		// too so a stranger sees a sign-in prompt, not an admin-looking page. The
		// data it fetches is separately gated above.
		if (method === "GET" && pathname === FLEET_PAGE) {
			if (!(await isStaff(await sessionUserId(context)))) {
				return Response.redirect(new URL("/login?redirect=/admin/fleet", context.url), 302);
			}
			return html(fleetPageHtml(), 200);
		}

		if (method === "POST" && pathname === ORG_CREATE_PATH) {
			const rejected = await guardOrgCreate(context, sites.primary, sites.limits ?? DEFAULT_LIMITS);
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
