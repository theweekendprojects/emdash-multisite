/**
 * Pure rules for creating and recovering sites. No database, no virtual
 * modules, so scripts/*.selfcheck.ts can import it under plain Node.
 */
import { isSiteId } from "./rewrite.ts";

export const ORG_CREATE_PATH = "/api/auth/organization/create";

/** Subdomain labels that must never become customer sites. */
export const RESERVED_SITE_IDS: ReadonlySet<string> = new Set([
	"www", "app", "api", "admin", "auth", "login", "mail", "smtp", "ftp", "cdn", "static",
	"assets", "dashboard", "console", "status", "docs", "help", "support", "billing", "internal",
]);

/** Template sites (a pre-built copy per theme that new sites are cloned from) live under this prefix. */
export const TEMPLATE_PREFIX = "tpl-";
export const templateId = (theme: string): string => `${TEMPLATE_PREFIX}${theme}`;
export const isTemplateId = (id: string): boolean => id.startsWith(TEMPLATE_PREFIX);

/** `null` when the slug can be a site id, otherwise a human-readable reason. */
export function slugProblem(slug: unknown, primary: string): string | null {
	if (typeof slug !== "string" || slug.length === 0) return "Choose a name for your site address.";
	if (!isSiteId(slug)) {
		return "Use 1-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.";
	}
	if (slug === primary || RESERVED_SITE_IDS.has(slug) || isTemplateId(slug)) return `"${slug}" is reserved. Choose another address.`;
	return null;
}

export type SiteStatus =
	| { status: "provisioning"; startedAt: string; step?: ProvisionStep }
	| { status: "ready"; startedAt: string; readyAt: string; timings?: Partial<Record<ProvisionStep, number>> }
	| { status: "failed"; startedAt: string; error: string };

interface CreatedOrg {
	id?: string;
	slug?: string;
	name?: string;
	metadata?: unknown;
	members?: Array<{ userId?: string; role?: string }>;
}

/** Provisioning phases, in order. Shown in the wizard and timed in the `ready` status. */
export type ProvisionStep = "tables" | "content" | "identity";

/** Pull the fields provisioning needs out of Better Auth's create-org response. */
export function parseCreatedOrg(
	body: unknown,
): { slug: string; name: string; ownerUserId: string; theme: string | null } | null {
	const o = body as CreatedOrg | null;
	const owner = o?.members?.find((m) => m.role === "owner") ?? o?.members?.[0];
	if (!o?.slug || !o.name || !owner?.userId) return null;
	return { slug: o.slug, name: o.name, ownerUserId: owner.userId, theme: themeFromMetadata(o.metadata) };
}

// ---- limits ----------------------------------------------------------------

/** Serializable (lives in the build-time config). `undefined` = no cap. */
export interface Limits {
	/** Sites one user may own. */
	sitesPerUser?: number;
	/** Sites on the whole platform (each site is ~90 D1 tables). */
	totalSites?: number;
	/** Media bytes one site may hold (sum of `media.size`). Checked before each upload. */
	mediaBytesPerSite?: number;
}

/** Object key a site's media lives under in the shared bucket. */
export const mediaKey = (site: string, key: string): string => `${site}/${key}`;
/** Inverse of `mediaKey`; `null` when the key belongs to another site. */
export const unmediaKey = (site: string, key: string): string | null =>
	key.startsWith(`${site}/`) ? key.slice(site.length + 1) : null;

/** A sane default so an unconfigured install is not an unlimited-site free-for-all. */
export const DEFAULT_LIMITS: Limits = { sitesPerUser: 3 };

export interface CreateContext {
	/** Signed-in user, or null. */
	userId: string | null;
	emailVerified: boolean;
	/** Sites this user already owns (includes failed ones, so retry beats re-create). */
	owned: number;
	/** All sites on the platform. */
	total: number;
}

export interface Problem {
	status: number;
	code: string;
	message: string;
}

/**
 * Why this user may not create another site, or `null` when they may.
 * An anonymous caller returns `null`: Better Auth answers 401 itself.
 */
export function createProblem(c: CreateContext, limits: Limits = DEFAULT_LIMITS): Problem | null {
	if (!c.userId) return null;
	if (!c.emailVerified) {
		return { status: 403, code: "EMAIL_NOT_VERIFIED", message: "Verify your email address before creating a site." };
	}
	if (limits.sitesPerUser !== undefined && c.owned >= limits.sitesPerUser) {
		return {
			status: 403,
			code: "SITE_LIMIT_REACHED",
			message: `You can own up to ${limits.sitesPerUser} site${limits.sitesPerUser === 1 ? "" : "s"}.`,
		};
	}
	if (limits.totalSites !== undefined && c.total >= limits.totalSites) {
		return { status: 503, code: "PLATFORM_FULL", message: "New sites are paused right now. Please try again later." };
	}
	return null;
}

// ---- recovery --------------------------------------------------------------

/**
 * A `provisioning` row older than this is a run that died. Work after a
 * response (`waitUntil`) gets ~30 s, so a live run is never older than ~35 s;
 * the blog theme's first run (tables ~25 s, then ~40 s of content) is killed
 * and finished by the next one.
 */
export const STALE_PROVISIONING_MS = 40_000;

/** Should provisioning run (again) for a site with this status? */
export function needsReconcile(status: SiteStatus | null, now: number, staleMs = STALE_PROVISIONING_MS): boolean {
	if (!status) return true;
	if (status.status === "failed") return true;
	if (status.status === "provisioning") return now - Date.parse(status.startedAt) > staleMs;
	return false;
}

// ---- themes ----------------------------------------------------------------

/** What a theme is to the platform. Serializable: it lives in the build-time config. */
export interface ThemeDef {
	/** Shown in the picker. */
	name: string;
	description?: string;
	/** EmDash seed (collections, settings, starter content) applied when a site picks this theme. */
	seed?: unknown;
}
export type Themes = Record<string, ThemeDef>;

/** Theme ids end up in an option value and a URL query, so keep them boring. */
export const THEME_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Id used when no themes are configured: the host's single bundled seed. */
export const BUNDLED_THEME = "default";

/**
 * The theme id carried in a Better Auth organization's `metadata`. Depending on
 * who wrote the row it is an object or a JSON string.
 */
export function themeFromMetadata(metadata: unknown): string | null {
	let m = metadata;
	if (typeof m === "string") {
		try {
			m = JSON.parse(m);
		} catch {
			return null;
		}
	}
	const t = (m as { theme?: unknown } | null)?.theme;
	return typeof t === "string" && t ? t : null;
}

/** Why `requested` cannot be used, or `null` (absent is fine: the default applies). */
export function themeProblem(requested: unknown, themes: Themes | undefined): string | null {
	if (requested === undefined || requested === null) return null;
	if (typeof requested !== "string" || !THEME_ID.test(requested)) return "Choose one of the available themes.";
	if (!themes || !Object.hasOwn(themes, requested)) return "Choose one of the available themes.";
	return null;
}

/**
 * The theme a site gets: the requested one when it is configured, else the
 * default (`defaultTheme`, else the first configured, else the bundled seed).
 * A stored theme that has since been removed from the config falls back too.
 */
export function effectiveTheme(requested: string | null, themes: Themes | undefined, defaultTheme?: string): string {
	const ids = Object.keys(themes ?? {});
	if (ids.length === 0) return BUNDLED_THEME;
	if (requested && ids.includes(requested)) return requested;
	return defaultTheme && ids.includes(defaultTheme) ? defaultTheme : ids[0]!;
}

// ---- theme routing ---------------------------------------------------------

/**
 * Each theme's pages live under this prefix in the host (`src/pages/theme-routes/<id>/`).
 * The middleware rewrites a public request to its site's theme subtree, so two
 * themes can both own `/` or `/contact` without colliding, and each theme's CSS
 * only loads on its own pages.
 */
export const THEME_ROUTE_PREFIX = "/theme-routes";

/** Paths owned by EmDash, Better Auth, the console or the platform: never themed. */
const NOT_THEMED =
	/^\/(?:_emdash|_astro|_image|api|auth|login|signup|account|organization|admin|audit-log|sites|\.well-known|theme-routes)(?:\/|$)|^\/(?:sitemap(?:-[^/]+)?\.xml|robots\.txt|llms\.txt)$/;

/** Is this a public page path that the site's theme renders? */
export function isThemed(pathname: string): boolean {
	return !NOT_THEMED.test(pathname);
}

/** Does this request address the theme subtree directly (which would bypass site selection)? */
export function isThemeRouteRequest(pathname: string): boolean {
	return pathname === THEME_ROUTE_PREFIX || pathname.startsWith(`${THEME_ROUTE_PREFIX}/`);
}

/** `/posts/hello` + `blog` -> `/theme-routes/blog/posts/hello`. */
export function themeRoute(theme: string, pathname: string): string {
	return `${THEME_ROUTE_PREFIX}/${theme}${pathname === "/" ? "" : pathname.replace(/\/$/, "")}`;
}

// ---- CSRF ------------------------------------------------------------------

/** Header every state-changing multisite API call must carry, as core requires for `/_emdash` APIs. */
export const CSRF_HEADER = "x-emdash-request";

/**
 * A browser cannot send a custom header cross-site without a CORS preflight we
 * never grant, so requiring it stops a forged form post or `fetch` from another
 * origin from riding the user's session cookie. Also accept a same-origin
 * `Origin` for clients that cannot add headers.
 */
export function csrfOk(headers: { get(name: string): string | null }, requestOrigin: string): boolean {
	if (headers.get(CSRF_HEADER) === "1") return true;
	return headers.get("origin") === requestOrigin;
}

// ---- theme switching -------------------------------------------------------

/** Collection slugs a theme's seed defines. */
export function seedCollections(seed: unknown): string[] {
	const cols = (seed as { collections?: Array<{ slug?: unknown }> } | null)?.collections;
	return Array.isArray(cols) ? cols.flatMap((c) => (typeof c?.slug === "string" ? [c.slug] : [])) : [];
}

/**
 * What switching `from` -> `to` does to the data model. Switching never deletes:
 * `adds` are collections the target needs (created empty, or with sample content
 * if asked), `hides` are collections the target does not display (content stays
 * and comes back if the owner switches back).
 */
export function switchSummary(themes: Themes, from: string, to: string): { adds: string[]; hides: string[] } {
	const a = seedCollections(themes[from]?.seed);
	const b = seedCollections(themes[to]?.seed);
	return { adds: b.filter((c) => !a.includes(c)), hides: a.filter((c) => !b.includes(c)) };
}

// ---- post-login landing ----------------------------------------------------

/** Where the control plane sends users after sign-in or sign-up when nothing else was asked. */
export const DEFAULT_POST_LOGIN_PATH = "/sites";

const AUTH_ENTRY = new Set(["/login", "/signup", "/auth/sign-in", "/auth/sign-up"]);

/** A path-only redirect target: starts with one `/`, not `//` or `/\` (which browsers read as another host). */
export const isLocalPath = (p: string): boolean => /^\/(?![/\\])/.test(p);

/**
 * The URL to redirect a sign-in / sign-up page request to, or null to serve it.
 * A signed-in visitor goes straight to the landing page; an anonymous one gets
 * the landing page added as `redirect` so Better Auth UI sends them there after
 * authenticating. An explicit `redirect` is always respected.
 */
export function loginEntryRedirect(url: URL, signedIn: boolean, landing: string): string | null {
	if (!AUTH_ENTRY.has(url.pathname)) return null;
	if (signedIn) return landing;
	if (url.searchParams.has("redirect")) return null;
	const next = new URL(url);
	next.searchParams.set("redirect", landing);
	return next.pathname + next.search;
}

// ---- site state (suspend / delete) -----------------------------------------

/**
 * Operational state of a site, kept on the control plane so a tenant can never
 * change it. `suspended` is reversible by staff; `deleted` is the owner's soft
 * delete: the site is hidden and unreachable, and staff can restore it until it
 * is purged.
 */
export type SiteState = { state: "suspended" | "deleted"; at: string; reason?: string };

export const STATE_KEY_PREFIX = "multisite:state:";

export function parseSiteState(raw: string | null | undefined): SiteState | null {
	if (!raw) return null;
	try {
		const v = JSON.parse(raw) as Partial<SiteState> | null;
		return v && (v.state === "suspended" || v.state === "deleted") && typeof v.at === "string"
			? { state: v.state, at: v.at, ...(typeof v.reason === "string" ? { reason: v.reason } : {}) }
			: null;
	} catch {
		return null;
	}
}

export type StateAction = "suspend" | "resume" | "delete" | "restore";

/**
 * What an action does from the current state, or why it cannot be done.
 * `next: null` means "back to active". Suspend/resume/restore are staff only;
 * the owner may delete.
 */
export function transition(
	current: SiteState | null,
	action: StateAction,
	actor: { staff: boolean; owner: boolean },
): { ok: true; next: SiteState["state"] | null } | { ok: false; status: number; code: string } {
	const forbidden = { ok: false, status: 403, code: "FORBIDDEN" } as const;
	const conflict = { ok: false, status: 409, code: "INVALID_STATE" } as const;
	switch (action) {
		case "suspend":
			if (!actor.staff) return forbidden;
			return current ? conflict : { ok: true, next: "suspended" };
		case "resume":
			if (!actor.staff) return forbidden;
			return current?.state === "suspended" ? { ok: true, next: null } : conflict;
		case "delete":
			if (!actor.staff && !actor.owner) return forbidden;
			return current?.state === "deleted" ? conflict : { ok: true, next: "deleted" };
		case "restore":
			if (!actor.staff) return forbidden;
			return current?.state === "deleted" ? { ok: true, next: null } : conflict;
	}
}

// ---- purge -----------------------------------------------------------------

/** Days a deleted site is kept (restorable) before its data is destroyed. */
export const DEFAULT_DELETE_GRACE_DAYS = 14;

export function isPurgeDue(state: SiteState | undefined | null, graceDays: number, now: number): boolean {
	return state?.state === "deleted" && now - Date.parse(state.at) >= graceDays * 86_400_000;
}

/**
 * Does the physical table `name` belong to site `slug`? Tables are `<t>$<slug>`; a
 * full-text table also owns shadow tables `<t>$<slug>_data|_idx|_content|_docsize|_config`.
 * Matching is exact on the slug, so `$a` never claims `$ab`.
 */
export function isTableOfSite(name: string, slug: string): boolean {
	const i = name.lastIndexOf(`$${slug}`);
	if (i < 1) return false;
	const rest = name.slice(i + 1 + slug.length);
	return rest === "" || /^_(?:data|idx|content|docsize|config)$/.test(rest);
}
