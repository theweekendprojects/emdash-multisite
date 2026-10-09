import { after } from "emdash";
import { runAsSite } from "./dialect.ts";
import { appearanceState, canManage, checkAddress, consoleState } from "./console.ts";
import { consolePageHtml } from "./console-page.ts";
import { isStaff, listSites } from "./fleet.ts";
import { fleetPageHtml } from "./fleet-page.ts";
import {
	ORG_CREATE_PATH,
	createSiteForOrg,
	parseCreatedOrg,
	pendingReconcile,
	planFor,
	readStatus,
	reconcile,
	slugProblem,
	switchTheme,
} from "./orgs.ts";
import {
	consumeHandoffNonce,
	handoffSecret,
	isEmailVerified,
	readAllStates,
	readOrgs,
	readSiteState,
	readSiteTheme,
	siteHasUser,
	warm,
	writeSiteState,
} from "./registry.ts";
import { sitesConfig } from "./config.ts";
import { signHandoff, verifyHandoff } from "./handoff.ts";
import { purgeSite } from "./purge.ts";
import { siteUrl } from "./sites.ts";
import { DEFAULT_DELETE_GRACE_DAYS, DEFAULT_LIMITS, DEFAULT_POST_LOGIN_PATH, csrfOk, isPurgeDue, loginEntryRedirect, transition, type SiteState, type StateAction, createProblem, needsReconcile, effectiveTheme, isThemeRouteRequest, isThemed, themeFromMetadata, themeProblem, themeRoute } from "./rules.ts";
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

/** Astro's `next`; a path argument rewrites the request. */
type Next = (rewrite?: string) => Promise<Response>;
interface Session {
	get(key: string): unknown | Promise<unknown>;
	set(key: string, value: unknown): void;
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
const forbidden = () => new Response(JSON.stringify({ code: "CSRF", message: "Missing or cross-site request." }), {
	status: 403,
	headers: { "content-type": "application/json", "cache-control": "no-store" },
});
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
async function guardOrgCreate(ctx: Ctx, sites: SitesConfig): Promise<Response | null> {
	const { primary } = sites;
	const limits = sites.limits ?? DEFAULT_LIMITS;
	let body: { slug?: unknown; metadata?: unknown } | null = null;
	try {
		body = (await ctx.request.clone().json()) as { slug?: unknown; metadata?: unknown };
	} catch {
		return null; // not JSON: let Better Auth produce its own error
	}
	const addressProblem = slugProblem(body?.slug, primary);
	if (addressProblem) return json({ code: "INVALID_SITE_ADDRESS", message: addressProblem }, 400);

	const themeIssue = themeProblem(themeFromMetadata(body?.metadata) ?? undefined, sites.themes);
	if (themeIssue && sites.themes) return json({ code: "INVALID_THEME", message: themeIssue }, 400);

	const userId = await sessionUserId(ctx);
	if (!userId) return null;
	const orgs = await readOrgs();
	const states = await readAllStates();
	const problem = createProblem(
		{
			userId,
			emailVerified: await isEmailVerified(userId),
			owned: orgs.filter((o) => o.ownerUserId === userId && states.get(o.slug)?.state !== "deleted").length,
			total: orgs.filter((o) => states.get(o.slug)?.state !== "deleted").length,
		},
		limits,
	);
	return problem ? json({ code: problem.code, message: problem.message }, problem.status) : null;
}

/**
 * Hand the request to EmDash, rewritten to the site's theme subtree when the
 * path is a public page. With no themes configured nothing is rewritten and
 * the host's own pages serve every site.
 *
 * Direct requests to the subtree (`/theme-routes/...`) are refused: they would
 * skip site selection and show one theme's pages on another site's host.
 */
async function themedNext(ctx: Ctx, sites: SitesConfig, site: string, next: Next): Promise<Response> {
	if (!sites.themes) return next();
	const { pathname } = ctx.url;
	if (isThemeRouteRequest(pathname)) return new Response("Not found", { status: 404 });
	if ((ctx.request.method !== "GET" && ctx.request.method !== "HEAD") || !isThemed(pathname)) return next();
	await warm();
	const theme = effectiveTheme(await readSiteTheme(site), sites.themes, sites.defaultTheme);
	return next(themeRoute(theme, pathname) + ctx.url.search);
}

/** What visitors of a suspended or deleted site see. A deleted site is indistinguishable from one that never existed. */
function unavailable(state: SiteState): Response {
	return state.state === "deleted"
		? html("<!doctype html><meta charset=utf-8><title>Not found</title><h1>Not found</h1>", 404)
		: html("<!doctype html><meta charset=utf-8><title>Site unavailable</title><h1>This site is unavailable</h1><p>It has been suspended. If this is your site, contact support.</p>", 503);
}

const HANDOFF_PATH = "/_multisite/handoff";
const noStore = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location, ...noStore } });
const handoffFailed = () =>
	html("<!doctype html><meta charset=utf-8><title>Link expired</title><p>This sign-in link has expired or was already used. Go back and open the admin again.</p>", 403);

/**
 * Tenant side of "Open admin": check the signed link the control plane made,
 * accept it once, start the user's session on this site and go to the admin.
 */
async function acceptHandoff(ctx: Ctx, site: string): Promise<Response> {
	const token = ctx.url.searchParams.get("t") ?? "";
	await warm();
	const claims = await verifyHandoff(await handoffSecret(), token, site);
	if (!claims) return handoffFailed();
	if (!(await siteHasUser(site, claims.uid))) return handoffFailed();
	if (!(await consumeHandoffNonce(site, claims.nonce, claims.exp))) return handoffFailed();
	ctx.session?.set("user", { id: claims.uid });
	return redirectTo("/_emdash/admin");
}

export async function onRequest(context: Ctx, next: Next): Promise<Response> {
	const sites = sitesConfig();
	if (!sites) return next();
	const state = scopeState();
	state.primary = sites.primary;
	const site = resolveSite(context.url.hostname, sites);

	return runAsSite(site, async () => {
		if (site !== sites.primary) {
			await warm();
			const blocked = await readSiteState(site);
			if (blocked) return unavailable(blocked);
			if (context.request.method === "GET" && context.url.pathname === HANDOFF_PATH) return acceptHandoff(context, site);
			return themedNext(context, sites, site, next);
		}
		const { pathname } = context.url;
		const { method } = context.request;
		if (pathname.startsWith("/api/multisite/") || pathname === FLEET_PAGE || pathname === ORG_CREATE_PATH || pathname.startsWith("/_multisite/") || /^\/sites\/[^/]+\/open-admin$/.test(pathname)) await warm();

		// Organization deletes would orphan the site's tables; deleting goes through the state route.
		if (method === "POST" && pathname === "/api/auth/organization/delete") {
			return json({ code: "USE_DELETE_SITE", message: "Delete the site from My sites instead." }, 403);
		}

		// Suspend / resume (staff) and delete / restore: the site's operational state.
		const stateApi = /^\/api\/multisite\/sites\/([a-z0-9-]+)\/state$/.exec(pathname);
		if (method === "POST" && stateApi) {
			if (!csrfOk(context.request.headers, context.url.origin)) return forbidden();
			const slug = stateApi[1]!;
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			let body: { action?: unknown } | null = null;
			try {
				body = (await context.request.json()) as { action?: unknown };
			} catch {
				return json({ code: "BAD_REQUEST" }, 400);
			}
			const action = body?.action as StateAction;
			if (!["suspend", "resume", "delete", "restore"].includes(action)) return json({ code: "BAD_REQUEST" }, 400);
			const org = (await readOrgs()).find((o) => o.slug === slug);
			if (!org || slug === sites.primary) return json({ code: "NOT_FOUND" }, 404);
			const staff = await isStaff(userId);
			const owner = org.ownerUserId === userId;
			if (!staff && !owner) return json({ code: "NOT_FOUND" }, 404);
			const result = transition(await readSiteState(slug), action, { staff, owner });
			if (!result.ok) return json({ code: result.code }, result.status);
			await writeSiteState(slug, result.next ? { state: result.next, at: new Date().toISOString(), reason: `${action} by ${userId}` } : null);
			return json({ state: result.next ?? "active" }, 200);
		}

		// Purge a deleted site for good (staff). Normally the cron does this after the grace period.
		const purgeApi = /^\/api\/multisite\/sites\/([a-z0-9-]+)\/purge$/.exec(pathname);
		if (method === "POST" && purgeApi) {
			if (!csrfOk(context.request.headers, context.url.origin)) return forbidden();
			const slug = purgeApi[1]!;
			if (!(await isStaff(await sessionUserId(context)))) return json({ code: "FORBIDDEN" }, 403);
			const current = await readSiteState(slug);
			if (current?.state !== "deleted" || slug === sites.primary) return json({ code: "INVALID_STATE" }, 409);
			const body = (await context.request.json().catch(() => null)) as { force?: unknown } | null;
			const graceDays = sites.deleteGraceDays ?? DEFAULT_DELETE_GRACE_DAYS;
			if (body?.force !== true && !isPurgeDue(current, graceDays, Date.now())) {
				return json({ code: "NOT_DUE", message: `Deleted sites are kept ${graceDays} days.` }, 409);
			}
			after(async () => {
				try {
					await runAsSite(site, () => purgeSite(slug));
				} catch (error) {
					console.error(`[multisite] purging "${slug}" failed:`, error);
				}
			});
			return json({ purging: true }, 202);
		}

		// Appearance: the owner's theme picker for one site.
		const appearancePage = /^\/sites\/([a-z0-9-]+)\/appearance$/.exec(pathname);
		if (method === "GET" && appearancePage) {
			if (!(await sessionUserId(context))) {
				return Response.redirect(new URL(`/login?redirect=${encodeURIComponent(pathname)}`, context.url), 302);
			}
			return html(consolePageHtml("appearance", appearancePage[1]), 200);
		}
		const appearanceApi = /^\/api\/multisite\/sites\/([a-z0-9-]+)\/(appearance|theme)$/.exec(pathname);
		if (appearanceApi) {
			const [, slug, kind] = appearanceApi as unknown as [string, string, string];
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			if (!(await canManage(userId, slug, sites.primary))) return json({ code: "FORBIDDEN" }, 403);
			if (method === "GET" && kind === "appearance") {
				const state = await appearanceState(slug, sites);
				return state ? json(state, 200) : json({ code: "NOT_FOUND" }, 404);
			}
			if (method === "POST" && kind === "theme") {
				if (!csrfOk(context.request.headers, context.url.origin)) return forbidden();
				let body: { theme?: unknown; includeContent?: unknown } | null = null;
				try {
					body = (await context.request.json()) as { theme?: unknown; includeContent?: unknown };
				} catch {
					return json({ code: "BAD_REQUEST" }, 400);
				}
				const issue = themeProblem(body?.theme, sites.themes);
				if (issue || typeof body?.theme !== "string") return json({ code: "INVALID_THEME", message: issue ?? "Choose a theme." }, 400);
				const state = await appearanceState(slug, sites);
				if (!state) return json({ code: "NOT_FOUND" }, 404);
				// Re-applying the current theme is allowed: it is additive and repairs a site
				// that is missing the theme's collections (for example after a seed change).
				if (slug !== sites.primary && (await readStatus(slug))?.status !== "ready") return json({ code: "NOT_READY" }, 409);
				if (await readSiteState(slug)) return json({ code: "NOT_ACTIVE" }, 409);
				const theme = body.theme;
				const includeContent = body.includeContent === true;
				after(async () => {
					try {
						await runAsSite(site, () => switchTheme(sites, slug, theme, { includeContent }));
					} catch (error) {
						console.error(`[multisite] switching "${slug}" to "${theme}" failed:`, error);
					}
				});
				return json({ switching: true, to: theme }, 202);
			}
		}

		if (method === "GET" && pathname.startsWith(STATUS_PREFIX)) {
			const slug = pathname.slice(STATUS_PREFIX.length);
			if (!isSiteId(slug)) return json({ code: "NOT_FOUND" }, 404);
			const status = await readStatus(slug);
			// Self-heal: whoever is watching a site whose run died restarts it, so a
			// killed run costs about a minute instead of a stuck site. Signed-in callers
			// only: the status URL is otherwise public.
			if (status?.status === "provisioning" && needsReconcile(status, Date.now()) && (await sessionUserId(context))) {
				after(async () => void (await runAsSite(site, () => reconcile(sites, slug))));
			}
			return status ? json(status, 200) : json({ code: "NOT_FOUND" }, 404);
		}

		// Sign-in / sign-up land on the console, not the marketing home.
		if (method === "GET") {
			const entry = loginEntryRedirect(
				context.url,
				(await sessionUserId(context)) !== null,
				sites.postLoginPath ?? (sites.accountTab ? "/account/sites" : DEFAULT_POST_LOGIN_PATH),
			);
			if (entry) return Response.redirect(new URL(entry, context.url), 302);
		}

		// "Open admin": sign a one-time link for the user and send them to the tenant.
		const openAdmin = /^\/sites\/([a-z0-9-]+)\/open-admin$/.exec(pathname);
		if (method === "GET" && openAdmin) {
			const slug = openAdmin[1]!;
			const userId = await sessionUserId(context);
			if (!userId) return redirectTo(`/login?redirect=${encodeURIComponent(pathname)}`);
			const base = siteUrl(slug, sites);
			if (!base || !(await canManage(userId, slug, sites.primary)) || slug === sites.primary || (await readSiteState(slug))) {
				return html("Not found", 404);
			}
			const token = await signHandoff(await handoffSecret(), { uid: userId, site: slug });
			return redirectTo(`${base}${HANDOFF_PATH}?t=${encodeURIComponent(token)}`);
		}

		// Customer console. Pages need a session (shell only, no data); the JSON
		// is separately gated by the same session.
		if (method === "GET" && sites.accountTab && (pathname === "/sites" || pathname === "/sites/new")) {
			return redirectTo(pathname === "/sites" ? "/account/sites" : "/account/sites?new=1");
		}
		if (method === "GET" && (pathname === "/sites" || pathname === "/sites/new")) {
			if (!(await sessionUserId(context))) {
				return Response.redirect(new URL(`/login?redirect=${encodeURIComponent(pathname)}`, context.url), 302);
			}
			return html(consolePageHtml(pathname === "/sites" ? "list" : "new"), 200);
		}
		if (method === "GET" && pathname === "/api/multisite/me") {
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			const state = await consoleState(userId, sites);
			const stalled = state.sites.find((x) => x.status === "provisioning" && x.canRetry);
			if (stalled) after(async () => void (await runAsSite(site, () => reconcile(sites, stalled.slug))));
			return json(state, 200);
		}
		// Themes a new site can pick (no seeds: those stay on the server).
		if (method === "GET" && pathname === "/api/multisite/themes") {
			if (!(await sessionUserId(context))) return json({ code: "UNAUTHORIZED" }, 401);
			const entries = Object.entries(sites.themes ?? {});
			const fallback = effectiveTheme(null, sites.themes, sites.defaultTheme);
			return json(
				{ default: fallback, themes: entries.map(([id, t]) => ({ id, name: t.name, description: t.description ?? "" })) },
				200,
			);
		}
		if (method === "GET" && pathname === "/api/multisite/slug-check") {
			if (!(await sessionUserId(context))) return json({ code: "UNAUTHORIZED" }, 401);
			return json(await checkAddress(context.url.searchParams.get("slug"), sites.primary), 200);
		}

		// Retry one site's provisioning: its owner or staff. Idempotent, 202 = started.
		if (method === "POST" && pathname.startsWith(STATUS_PREFIX) && pathname.endsWith("/retry")) {
			if (!csrfOk(context.request.headers, context.url.origin)) return forbidden();
			const slug = pathname.slice(STATUS_PREFIX.length, -"/retry".length);
			if (!isSiteId(slug)) return json({ code: "NOT_FOUND" }, 404);
			const userId = await sessionUserId(context);
			if (!userId) return json({ code: "UNAUTHORIZED" }, 401);
			const org = (await readOrgs()).find((o) => o.slug === slug);
			if (!org) return json({ code: "NOT_FOUND" }, 404);
			if (org.ownerUserId !== userId && !(await isStaff(userId))) return json({ code: "FORBIDDEN" }, 403);
			if ((await pendingReconcile(slug)).length === 0) return json({ code: "NOT_NEEDED" }, 409);
			after(async () => void (await runAsSite(site, () => reconcile(sites, slug))));
			return json({ retrying: true }, 202);
		}

		// Staff: re-run the next stuck site (failed, or provisioning that died). One per call; call again for the next.
		if (method === "POST" && pathname === RECONCILE_API) {
			if (!csrfOk(context.request.headers, context.url.origin)) return forbidden();
			if (!(await isStaff(await sessionUserId(context)))) return json({ code: "FORBIDDEN" }, 403);
			const slugs = await pendingReconcile();
			if (slugs.length) after(async () => void (await runAsSite(site, () => reconcile(sites))));
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
			const rejected = await guardOrgCreate(context, sites);
			if (rejected) return rejected;
			const response = await next();
			if (response.status === 200) {
				const org = parseCreatedOrg(await response.clone().json().catch(() => null));
				// Provisioning outlives the response: `after` uses the Worker's waitUntil.
				if (org) after(() => runAsSite(site, () => createSiteForOrg(org, planFor(sites, { theme: org.theme }))));
			}
			return response;
		}

		return themedNext(context, sites, site, next);
	});
}
