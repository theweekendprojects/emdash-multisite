import { isSiteId } from "./rewrite.ts";
import type { Limits } from "./rules.ts";

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
}

export function assertSitesConfig(c: SitesConfig): void {
	if (!isSiteId(c.primary)) throw new Error(`[multisite] invalid primary site id: ${c.primary}`);
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
