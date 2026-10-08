import { Kysely, sql } from "kysely";
import { siteDialect, runAsSite } from "./dialect.ts";
import { scopeState } from "./scope.ts";

/**
 * Make the control-plane (primary) site usable without the first-run wizard.
 *
 * The primary site's first human arrives through Better Auth signup as a
 * subscriber (role 10), not through EmDash's setup wizard. So the wizard would
 * appear and then refuse ("admin user already exists"). This promotes a named
 * user to admin and marks setup complete — run it ONCE, for your own staff
 * account, from a trusted script. It never runs automatically.
 *
 * Tenant sites don't need this: provisioning already creates their admin and
 * sets the flag (see createSiteForOrg).
 *
 * ```ts
 * import { Kysely } from "kysely";
 * import { createDialect } from "emdash-multisite/db/d1"; // or /db/sqlite
 * import { bootstrapControlPlane } from "emdash-multisite/bootstrap";
 * const db = new Kysely({ dialect: createDialect({ inner, sites }) });
 * await bootstrapControlPlane(db, "you@example.com");
 * ```
 */
export async function bootstrapControlPlane(
	db: Kysely<never>,
	adminEmail: string,
): Promise<{ promoted: boolean }> {
	const primary = scopeState().primary;
	return runAsSite(primary, async () => {
		const upd = await sql`
			UPDATE users SET role = 50, email_verified = 1
			WHERE lower(email) = ${adminEmail.toLowerCase()}`.execute(db);
		const promoted = Number(upd.numAffectedRows ?? 0n) > 0;
		if (!promoted) {
			throw new Error(
				`[multisite] no user "${adminEmail}" on the control-plane site. Sign up first, then run bootstrap.`,
			);
		}
		await sql`INSERT INTO options (name, value) VALUES ('emdash:setup_complete', 'true')
			ON CONFLICT(name) DO UPDATE SET value = 'true'`.execute(db);
		return { promoted };
	});
}

/** Build the control-plane connection the bootstrap/scripts use. */
export function controlPlaneDb(): Kysely<never> {
	const st = scopeState();
	if (!st.inner) throw new Error("[multisite] database not initialised yet");
	return new Kysely<never>({ dialect: siteDialect(st.inner, st.activeSite, st.primary) });
}
