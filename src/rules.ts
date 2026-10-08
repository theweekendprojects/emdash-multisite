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

/** `null` when the slug can be a site id, otherwise a human-readable reason. */
export function slugProblem(slug: unknown, primary: string): string | null {
	if (typeof slug !== "string" || slug.length === 0) return "Choose a name for your site address.";
	if (!isSiteId(slug)) {
		return "Use 1-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.";
	}
	if (slug === primary || RESERVED_SITE_IDS.has(slug)) return `"${slug}" is reserved. Choose another address.`;
	return null;
}

export type SiteStatus =
	| { status: "provisioning"; startedAt: string }
	| { status: "ready"; startedAt: string; readyAt: string }
	| { status: "failed"; startedAt: string; error: string };

interface CreatedOrg {
	id?: string;
	slug?: string;
	name?: string;
	members?: Array<{ userId?: string; role?: string }>;
}

/** Pull the fields provisioning needs out of Better Auth's create-org response. */
export function parseCreatedOrg(body: unknown): { slug: string; name: string; ownerUserId: string } | null {
	const o = body as CreatedOrg | null;
	const owner = o?.members?.find((m) => m.role === "owner") ?? o?.members?.[0];
	if (!o?.slug || !o.name || !owner?.userId) return null;
	return { slug: o.slug, name: o.name, ownerUserId: owner.userId };
}

// ---- limits ----------------------------------------------------------------

/** Serializable (lives in the build-time config). `undefined` = no cap. */
export interface Limits {
	/** Sites one user may own. */
	sitesPerUser?: number;
	/** Sites on the whole platform (each site is ~90 D1 tables). */
	totalSites?: number;
}

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

/** A `provisioning` row older than this is a run that died (Worker evicted). */
export const STALE_PROVISIONING_MS = 5 * 60_000;

/** Should provisioning run (again) for a site with this status? */
export function needsReconcile(status: SiteStatus | null, now: number, staleMs = STALE_PROVISIONING_MS): boolean {
	if (!status) return true;
	if (status.status === "failed") return true;
	if (status.status === "provisioning") return now - Date.parse(status.startedAt) > staleMs;
	return false;
}
