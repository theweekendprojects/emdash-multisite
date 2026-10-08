import { Kysely, type Dialect } from "kysely";
import { siteDialect } from "./dialect.ts";
import { activeSite, scopeState } from "./scope.ts";
import { resolveSite, type SitesConfig } from "./sites.ts";

/** Config the wrapped descriptor hands to its runtime entrypoint. */
export interface TenancyConfig<InnerConfig = unknown> {
	inner: InnerConfig;
	sites: SitesConfig;
}

/** Subset of core's RequestScopedDbOpts this wrapper reads. */
interface ScopedOpts {
	config: unknown;
	url: URL;
}

/**
 * Build the `createDialect` / `createRequestScopedDb` pair core expects from a
 * descriptor entrypoint, around an inner adapter's `createDialect`.
 *
 * ponytail: one database config per isolate (a Worker has exactly one DB
 * descriptor), so the inner dialect and per-site Kysely instances are cached
 * at module scope without keying on config.
 */
export function makeRuntime<InnerConfig>(createInner: (config: InnerConfig) => Dialect) {
	let inner: Dialect | undefined;
	const getInner = (c: TenancyConfig<InnerConfig>) => (inner ??= createInner(c.inner));
	const perSite = new Map<string, Kysely<unknown>>();

	return {
		/** Singleton path: boot, migrations, cron. Site comes from `runAsSite`, else primary. */
		createDialect(config: TenancyConfig<InnerConfig>): Dialect {
			scopeState().primary = config.sites.primary;
			// The shared singleton also serves per-site runtimes, so its site is resolved per query
			// (request's site handle, else runAsSite, else primary), never fixed at creation.
			return siteDialect(getInner(config), activeSite, config.sites.primary);
		},

		/**
		 * Per-request path: the site is resolved from the hostname and baked into
		 * a cached per-site Kysely, so nothing downstream can run unscoped.
		 * Always returns a handle (never null), or core would fall back to the
		 * primary-site singleton for every request.
		 */
		createRequestScopedDb(opts: ScopedOpts): { db: Kysely<unknown>; commit: () => void } {
			const config = opts.config as TenancyConfig<InnerConfig>;
			const site = resolveSite(opts.url.hostname, config.sites);
			let db = perSite.get(site);
			if (!db) {
				db = new Kysely<unknown>({ dialect: siteDialect(getInner(config), () => site, config.sites.primary) });
				perSite.set(site, db);
				scopeState().siteOfDb.set(db, site);
			}
			scopeState().primary = config.sites.primary;
			return { db, commit: () => {} };
		},
	};
}
