import { isSiteId } from "./rewrite.ts";
import { THEME_ID, isLocalPath, type Limits, type Themes } from "./rules.ts";

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
	 * Themes a new site can pick, each with its seed. Omit for a single theme
	 * (the host's bundled seed).
	 * ponytail: seeds are embedded in the build-time config, which bloats it by
	 * the size of the seeds (tens of KB each). Upgrade path: a virtual module
	 * generated from a themes/ directory.
	 */
	themes?: Themes;
	/** Days a deleted site stays restorable before its data is purged. Default 14. */
	deleteGraceDays?: number;
	/** Where users land after signing in or up on the control plane. Defaults to `/sites`. */
	postLoginPath?: string;
	/** Theme preselected in the wizard and used when none is requested. Defaults to the first theme. */
	defaultTheme?: string;
}

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
	if (c.deleteGraceDays !== undefined && (!Number.isInteger(c.deleteGraceDays) || c.deleteGraceDays < 0)) {
		throw new Error("[multisite] deleteGraceDays must be a non-negative integer");
	}
	for (const [k, v] of Object.entries(c.limits ?? {})) {
		if (v !== undefined && (!Number.isInteger(v) || v < 0)) throw new Error(`[multisite] limits.${k} must be a non-negative integer`);
	}
	for (const [host, id] of Object.entries(c.hosts ?? {})) {
		if (!isSiteId(id)) throw new Error(`[multisite] invalid site id for ${host}: ${id}`);
	}
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
