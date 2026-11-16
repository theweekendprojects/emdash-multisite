import { isSiteId } from "./rewrite.ts";
import { THEME_ID, isLocalPath, type Limits, type Themes } from "./rules.ts";
import { LOCALES, matchLocale } from "./i18n.ts";

/** Serializable (lives in the build-time database descriptor). */
export interface SitesConfig {
	/** Site that keeps the original unprefixed tables. */
	primary: string;
	/** Exact hostname -> site id (custom domains). */
	hosts?: Record<string, string>;
	/** Base domain: `acme.example.com` -> site `acme`. */
	wildcard?: string;
	/** Caps on site creation. Defaults to 3 sites per user, no platform cap. */
	limits?: Limits;
	/**
	 * Make the site's sign-up state available to themes as `Astro.locals.multisite` (`{ signup, account }`), for the
	 * host's `AuthLinks` component that draws Sign in / Sign up / My account / Admin inside the theme header
	 * (see `authLinksFor`). Customer sites offer Sign in / Sign up only while their public sign-up is on. Default off.
	 */
	authLinks?: boolean;
	/** Extra email domains refused at sign-up, on top of the built-in disposable-mail list. */
	blockedEmailDomains?: string[];
	/**
	 * Themes a new site can pick, each with its seed. Omit for a single theme
	 * (the host's bundled seed).
	 * ponytail: seeds are embedded in the build-time config, which bloats it by
	 * the size of the seeds (tens of KB each). Upgrade path: a virtual module
	 * generated from a themes/ directory.
	 */
	themes?: Themes;
	/**
	 * The host shows "My sites" as a tab in Better Auth UI's account page
	 * (`/account/sites`, see `emdash-multisite/auth-ui`). `/sites` then redirects
	 * there and users land on it after signing in.
	 */
	accountTab?: boolean;
	/** Public address of the app (account, my sites), e.g. `https://app.example.com`. Used for links back from a site's admin. */
	appUrl?: string;
	/** Days a deleted site stays restorable before its data is purged. Default 14. */
	deleteGraceDays?: number;
	/** Where users land after signing in or up on the control plane. Defaults to `/sites`. */
	postLoginPath?: string;
	/** Theme preselected in the wizard and used when none is requested. Defaults to the first theme. */
	defaultTheme?: string;
	/**
	 * Extra D1 bindings (shards) that can hold sites, besides the database of the wrapped descriptor. Declare each one in
	 * the Worker config ahead of demand: D1 bindings are static, so a site can only move to a database that is already
	 * bound. Today every site still lives in the descriptor's database (see `shardOf`): this only makes the pool reachable.
	 */
	shards?: string[];
	/**
	 * Language of the console, Fleet, the site admin page, status pages and API messages, e.g. `"fr"`.
	 * Defaults to the EmDash (Astro) i18n default locale, then English. One language per deployment:
	 * it is never negotiated from the request.
	 */
	locale?: string;
}

/** A Worker binding name, as wrangler accepts it. */
const BINDING_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertSitesConfig(c: SitesConfig): void {
	if (!isSiteId(c.primary)) throw new Error(`[multisite] invalid primary site id: ${c.primary}`);
	if (c.postLoginPath !== undefined && !isLocalPath(c.postLoginPath)) {
		throw new Error(`[multisite] postLoginPath must be a path on this site: ${c.postLoginPath}`);
	}
	for (const id of Object.keys(c.themes ?? {})) {
		if (!THEME_ID.test(id)) throw new Error(`[multisite] invalid theme id: ${id}`);
	}
	if (c.defaultTheme && !Object.hasOwn(c.themes ?? {}, c.defaultTheme)) {
		throw new Error(`[multisite] defaultTheme "${c.defaultTheme}" is not in themes`);
	}
	if (c.locale !== undefined && !matchLocale(c.locale)) {
		throw new Error(`[multisite] locale "${c.locale}" has no catalog (available: ${LOCALES.join(", ")})`);
	}
	if (c.appUrl !== undefined && !/^https?:\/\/[^/\s]+$/.test(c.appUrl)) throw new Error("[multisite] appUrl must be an origin like https://app.example.com (no path)");
	if (c.deleteGraceDays !== undefined && (!Number.isInteger(c.deleteGraceDays) || c.deleteGraceDays < 0)) {
		throw new Error("[multisite] deleteGraceDays must be a non-negative integer");
	}
	if (c.limits?.concurrentProvisions !== undefined && c.limits.concurrentProvisions < 1) throw new Error("[multisite] limits.concurrentProvisions must be at least 1");
	for (const [k, v] of Object.entries(c.limits ?? {})) {
		if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`[multisite] limits.${k} must be a non-negative integer`);
	}
	if (c.blockedEmailDomains && !c.blockedEmailDomains.every((d) => typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))) {
		throw new Error("[multisite] blockedEmailDomains must be domain names like example.com");
	}
	for (const [host, id] of Object.entries(c.hosts ?? {})) {
		if (!isSiteId(id)) throw new Error(`[multisite] invalid site id for ${host}: ${id}`);
	}
	if (c.shards !== undefined) {
		if (!Array.isArray(c.shards) || !c.shards.every((b) => typeof b === "string" && BINDING_NAME.test(b))) {
			throw new Error("[multisite] shards must be D1 binding names like DB_SHARD_1");
		}
		if (new Set(c.shards).size !== c.shards.length) throw new Error("[multisite] shards lists a binding twice");
	}
}

/**
 * The shard binding that holds `site`'s tables, or `undefined` for the database of the wrapped descriptor.
 * The primary site always lives there.
 *
 * ponytail: no assignment yet, so every site lives in the descriptor's database. Upgrade path: read the
 * site's shard from its site record, written once when the site is created.
 */
export function shardOf(_site: string, _c: SitesConfig): string | undefined {
	return undefined;
}

/**
 * Hostname -> site id. Unknown hosts (localhost, workers.dev previews) fall
 * back to the primary site, which is what a single-site install does anyway.
 */
export function resolveSite(hostname: string, c: SitesConfig): string {
	const host = hostname.toLowerCase().replace(/:\d+$/, "");
	const exact = c.hosts?.[host];
	if (exact) return exact;
	if (c.wildcard && host.endsWith(`.${c.wildcard}`)) {
		const label = host.slice(0, -(c.wildcard.length + 1));
		if (isSiteId(label)) return label;
	}
	return c.primary;
}

/**
 * Public address of a site, or `null` when no hostname is configured for it.
 * An exact `hosts` entry wins (it is what the Worker actually routes), then the
 * wildcard base domain.
 */
export function siteUrl(slug: string, c: SitesConfig): string | null {
	const host = Object.entries(c.hosts ?? {}).find(([, id]) => id === slug)?.[0];
	if (host) return `https://${host}`;
	return c.wildcard ? `https://${slug}.${c.wildcard}` : null;
}
