import type { DatabaseDescriptor } from "emdash/db";
import { assertSitesConfig, type SitesConfig } from "./sites.ts";

export { runAsSite } from "./dialect.ts";
export { multisitePlugin } from "./plugin.ts";
export { resolveSite, type SitesConfig } from "./sites.ts";

/** Inner adapter entrypoint -> our wrapping entrypoint. */
const WRAPPERS: Record<string, string> = {
	"emdash/db/sqlite": "emdash-multisite/db/sqlite",
	"@emdash-cms/cloudflare/db/d1": "emdash-multisite/db/d1",
};

/**
 * Wrap a database descriptor so one database serves many sites.
 *
 * ```ts
 * emdash({ database: withSites(d1({ binding: "DB" }), { primary: "main", wildcard: "example.com" }) })
 * ```
 */
export function withSites(inner: DatabaseDescriptor, sites: SitesConfig): DatabaseDescriptor {
	assertSitesConfig(sites);
	const entrypoint = WRAPPERS[inner.entrypoint];
	if (!entrypoint) {
		throw new Error(`[multisite] unsupported database adapter: ${inner.entrypoint}`);
	}
	return {
		entrypoint,
		config: { inner: inner.config, sites },
		type: inner.type,
		supportsRequestScope: true,
		// Omitted on purpose: `migrations` (deploy-time runner and coalescing and
		// the collection-deletion guard address one site's tables only).
	};
}
