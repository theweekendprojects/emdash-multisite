import type { Kysely } from "kysely";
import { runMigrations } from "emdash/db";
import { runAsSite } from "./dialect.ts";
import { isSiteId } from "./rewrite.ts";

/**
 * Create (or upgrade) one site's tables by running core's migrations as that
 * site. `db` must be a Kysely built on the wrapped dialect. Idempotent.
 */
export async function provisionSite(db: Kysely<never>, site: string): Promise<{ applied: string[] }> {
	if (!isSiteId(site)) throw new Error(`[multisite] invalid site id: ${site}`);
	// eslint-disable-next-line typescript/no-explicit-any -- core types its own Database
	return runAsSite(site, () => runMigrations(db as any));
}
