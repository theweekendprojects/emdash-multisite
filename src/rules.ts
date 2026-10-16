/**
 * Pure rules for creating and recovering sites. No database, no virtual
 * modules, so scripts/*.selfcheck.ts can import it under plain Node.
 */
import { isSiteId } from "./rewrite.ts";

export const ORG_CREATE_PATH = "/api/auth/organization/create";

export const SIGNUP_PATH = "/api/auth/sign-up/email";
/**
 * Subdomain labels that must never become customer sites: infrastructure and mail names,
 * words that make a phishing address look official (`login`, `secure`, `billing`), and
 * big brands. ponytail: a short list, not a moderation system. Upgrade path: a
 * `reservedSiteIds` config option, or review at creation for anything borderline.
 */
export const RESERVED_SITE_IDS: ReadonlySet<string> = new Set([
	"www", "app", "api", "admin", "auth", "login", "mail", "smtp", "ftp", "cdn", "static",
	"assets", "dashboard", "console", "status", "docs", "help", "support", "billing", "internal",
	"root", "administrator", "webmaster", "postmaster", "hostmaster", "abuse", "security", "noc", "noreply", "no-reply",
	"ns", "ns1", "ns2", "dns", "mx", "imap", "pop", "pop3", "webmail", "email", "autodiscover", "autoconfig",
	"account", "accounts", "signin", "sign-in", "signup", "sign-up", "register", "verify", "oauth", "sso", "secure",
	"pay", "payment", "payments", "checkout", "wallet", "bank", "invoice",
	"staging", "stage", "dev", "preview", "sandbox", "beta", "alpha", "prod", "production", "origin", "edge",
	"media", "files", "upload", "uploads", "download", "downloads", "img", "images", "storage",
	"legal", "privacy", "terms", "sales", "staff",
	"cloudflare", "emdash", "astro", "google", "microsoft", "apple", "amazon", "facebook", "meta", "paypal", "stripe", "github",
]);
/**
 * Throwaway-mail domains. Sign-up with one of these is refused, so a bot cannot mint
 * accounts (each able to create sites) from an inbox it never reads.
 * ponytail: a seed list that goes stale. Upgrade path: a maintained list, or Turnstile.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
	"mailinator.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "sharklasers.com", "grr.la",
	"10minutemail.com", "10minutemail.net", "tempmail.com", "temp-mail.org", "temp-mail.io", "tempmailo.com",
	"throwawaymail.com", "yopmail.com", "yopmail.net", "trashmail.com", "trashmail.net", "getnada.com", "nada.email",
	"maildrop.cc", "dispostable.com", "fakeinbox.com", "mailnesia.com", "mintemail.com", "mohmal.com", "emailondeck.com",
	"spamgourmet.com", "mytemp.email", "tempinbox.com", "burnermail.io", "moakt.com", "discard.email", "tmpmail.org",
]);
/** True when the address's domain (or a parent of it) is on the built-in list or in `extra`. */
export function emailDomainBlocked(email: unknown, extra: readonly string[] = []): boolean {
	if (typeof email !== "string") return false;
	const at = email.lastIndexOf("@");
	if (at < 0) return false;
	const labels = email.slice(at + 1).trim().toLowerCase().split(".");
	const blocked = new Set([...DISPOSABLE_EMAIL_DOMAINS, ...extra.map((d) => d.toLowerCase())]);
	// "a.b.mailinator.com" is blocked by "mailinator.com".
	return labels.some((_, i) => blocked.has(labels.slice(i).join(".")));
}
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
export type ProvisionStep = "queued" | "tables" | "content" | "identity";

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
	/** Sites provisioned at the same time, platform-wide (default 1: measured, see OP-43). The rest wait their turn. */
	concurrentProvisions?: number;
}

/** Object key a site's media lives under in the shared bucket. */
export const mediaKey = (site: string, key: string): string => `${site}/${key}`;
/** Inverse of `mediaKey`; `null` when the key belongs to another site. */
export const unmediaKey = (site: string, key: string): string | null =>
	key.startsWith(`${site}/`) ? key.slice(site.length + 1) : null;

/** A sane default so an unconfigured install is not an unlimited-site free-for-all. */
export const DEFAULT_LIMITS: Limits = { sitesPerUser: 3 };
/** The configured limits on top of the defaults: setting one limit (say `mediaBytesPerSite`) must not silently drop the 3-site cap. */
export const effectiveLimits = (configured: Limits | undefined): Limits => ({ ...DEFAULT_LIMITS, ...configured });

/** The subset of `Limits` a billing plan grants (sites + storage). */
export type PlanLimits = Pick<Limits, "sitesPerUser" | "mediaBytesPerSite">;

/** GiB in bytes, for readable storage caps. */
const GiB = 1024 ** 3;

/**
 * Plan name (the Better Auth / Stripe subscription `plan` field, lowercased) →
 * resource limits. Kept HERE, not imported from `emdash-better-auth`, so this
 * private package stays decoupled from the open-source plugin (the plugin owns
 * the Stripe price catalog + pricing display; this map owns what each tier is
 * ALLOWED to provision). The two must agree on the tier NAMES — that is the only
 * contract between them. A plan not in this map falls back to the free tier.
 *
 * Mirrors the plugin's ladder: Pro (individual) → Business (team) → Agency
 * (many client sites) → Enterprise (custom, high ceiling).
 */
export const PLAN_LIMITS: Readonly<Record<string, PlanLimits>> = {
	pro: { sitesPerUser: 3, mediaBytesPerSite: 10 * GiB },
	// Enterprise's built-in caps are a high ceiling only; the real per-customer
	// caps come from the metadata on their manual Stripe subscription (folded
	// into a per-user override by the billing webhook). See
	// emdash-plan/product/better-auth-stripe-features.md.
	enterprise: { sitesPerUser: 1000, mediaBytesPerSite: 1000 * GiB },
};

/** Limits for a user with NO active subscription (the free tier baseline). */
export const FREE_PLAN_LIMITS: PlanLimits = { sitesPerUser: 1, mediaBytesPerSite: 1 * GiB };

/** The limits a plan name grants; unknown/empty (no subscription) → free tier. */
export const planLimits = (plan: string | null | undefined): PlanLimits =>
	plan ? (PLAN_LIMITS[plan.toLowerCase()] ?? FREE_PLAN_LIMITS) : FREE_PLAN_LIMITS;

/**
 * Merge a subscriber's PLAN limits on top of the host's configured limits (which
 * themselves sit on {@link DEFAULT_LIMITS}). A plan value wins when set; a plan
 * that omits a key leaves the configured/default value in place, so turning on
 * billing never drops an unrelated cap. Pure + unit-testable; the caller does
 * the subscription read and passes the resolved plan name through
 * {@link planLimits}.
 */
export const limitsForPlan = (configured: Limits | undefined, plan: PlanLimits): Limits => {
	const base = effectiveLimits(configured);
	return {
		...base,
		...(plan.sitesPerUser !== undefined ? { sitesPerUser: plan.sitesPerUser } : {}),
		...(plan.mediaBytesPerSite !== undefined ? { mediaBytesPerSite: plan.mediaBytesPerSite } : {}),
	};
};

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

/**
 * Did this freshly created site lose a race against its owner's other creations?
 * `createProblem` runs BEFORE Better Auth creates the org, so parallel requests all see
 * "0 owned" and all pass. Run again AFTER creation: sites are ranked by creation time
 * (slug breaks ties, so every parallel request ranks them the same way), and a site
 * ranked past the limit loses. Deleted sites do not count.
 */
export function lostLimitRace(
	slug: string,
	orgs: ReadonlyArray<{ slug: string; ownerUserId: string | null; createdAt: string | null }>,
	deleted: ReadonlySet<string>,
	limits: Limits = DEFAULT_LIMITS,
): boolean {
	const order = (a: { slug: string; createdAt: string | null }, b: { slug: string; createdAt: string | null }) =>
		(a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.slug.localeCompare(b.slug);
	const live = orgs.filter((o) => !deleted.has(o.slug)).sort(order);
	const me = live.find((o) => o.slug === slug);
	if (!me) return false;
	const mine = live.filter((o) => o.ownerUserId === me.ownerUserId);
	if (limits.sitesPerUser !== undefined && mine.indexOf(me) >= limits.sitesPerUser) return true;
	return limits.totalSites !== undefined && live.indexOf(me) >= limits.totalSites;
}

// ---- public theme demos ------------------------------------------------------

/** Public paths a demo may serve besides its pages: search results and media files. */
const DEMO_OPEN_API = ["/_emdash/api/search", "/_emdash/api/media/file/"];
/**
 * A template site doubles as a public, read-only demo of its theme. Returns the HTTP status to refuse a
 * request with, or `null` to let it through: only GET/HEAD, and no admin, auth, plugin or write APIs.
 */
export function demoGuard(method: string, pathname: string): number | null {
	if (method !== "GET" && method !== "HEAD") return 405;
	if (pathname.startsWith("/api/") || pathname.startsWith("/_multisite/")) return 404;
	if (pathname.startsWith("/_emdash") && !DEMO_OPEN_API.some((p) => (p.endsWith("/") ? pathname.startsWith(p) : pathname === p))) return 404;
	return null;
}
const escapeHtml = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The strip shown at the bottom of a demo page. `url` is where "Use this theme" goes. */
export function demoBannerHtml(themeName: string, url: string): string {
	// The strip is fixed to the bottom; padding keeps it from covering the footer (theme switcher, links).
	return `<style>body{padding-bottom:64px}</style><div role="region" aria-label="Theme demo" style="position:fixed;inset:auto 0 0 0;z-index:2147483647;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;padding:10px 16px;background:#111827;color:#fff;font:500 14px/1.4 system-ui,sans-serif">`
		+ `<span>This is a demo of the ${escapeHtml(themeName)} theme.</span>`
		+ `<a href="${escapeHtml(url)}" style="background:#fff;color:#111827;padding:6px 12px;border-radius:8px;text-decoration:none;font-weight:600">Use this theme</a></div>`;
}

// ---- backups ---------------------------------------------------------------

/** Backups kept per site; older ones are deleted when a new one is saved. */
export const BACKUP_KEEP = 7;
export const BACKUP_EVERY_MS = 24 * 3_600_000;
/** Folder of a site's backups in the media bucket. Site ids start with a letter or digit, so `_backups` never collides with a site's media prefix. */
export const backupPrefix = (slug: string): string => `_backups/${slug}/`;
export const backupKey = (slug: string, iso: string, tag?: string): string => `${backupPrefix(slug)}${iso}${tag ? `-${tag}` : ""}.json`;
/** A backup is due when there is none yet or the last one is a day old. */
export const backupDue = (lastIso: string | undefined, now: number): boolean => !lastIso || now - Date.parse(lastIso) >= BACKUP_EVERY_MS;

// ---- recovery --------------------------------------------------------------

/**
 * A `provisioning` row older than this is a run that died. Work after a
 * response (`waitUntil`) gets ~30 s, so a live run is never older than ~35 s;
 * the blog theme's first run (tables ~25 s, then ~40 s of content) is killed
 * and finished by the next one.
 */
export const STALE_PROVISIONING_MS = 40_000;

/**
 * The cron finishes stuck sites in a loop. A site made from a template takes a few seconds, one without takes up to ~90 s, and
 * ticks are 5 minutes apart (two ticks must not both pick up the same half-finished site), so a tick starts another site only
 * while fewer than 150 s have passed and at most 10 per tick.
 */
export const RECONCILE_MAX_PER_TICK = 10;
export const RECONCILE_START_BUDGET_MS = 150_000;
export const mayStartAnother = (done: number, elapsedMs: number): boolean => done < RECONCILE_MAX_PER_TICK && elapsedMs < RECONCILE_START_BUDGET_MS;

/** Provisioning slots (see slots.ts): the default cap, how long a slot lives if its holder dies, how long one attempt waits, and how soon a queued site is retried. */
export const DEFAULT_CONCURRENT_PROVISIONS = 1;
export const SLOT_PREFIX = "multisite:slot:";
export const SLOT_TTL_MS = 150_000;
export const SLOT_WAIT_MS = 6_000;
export const QUEUED_RETRY_MS = 8_000;

/** Should provisioning run (again) for a site with this status? */
export function needsReconcile(status: SiteStatus | null, now: number, staleMs = STALE_PROVISIONING_MS): boolean {
	if (!status) return true;
	if (status.status === "failed") return true;
	// A site waiting for a slot is retried soon (every few seconds, so two attempts never overlap); a dead run is detected by age.
	if (status.status === "provisioning") return now - Date.parse(status.startedAt) > (status.step === "queued" ? QUEUED_RETRY_MS : staleMs);
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
	/** Plain-words label for the picker ("A blog") and a one-line pitch ("Write posts and share ideas"). */
	pitch?: string;
	/** A screenshot of the theme (a path on the app host), shown on the picker cards. */
	preview?: string;
	/** "What next" links shown when the site is ready: a label and an admin path (`/_emdash/admin/...`) on the new site. */
	checklist?: Array<{ label: string; path: string }>;
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

