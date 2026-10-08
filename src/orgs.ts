/**
 * "Creating an organization creates a site."
 *
 * Watches ONE Better Auth call on the control-plane site, POST
 * /api/auth/organization/create, without changing the (open-source) plugin:
 *   - before: rejects a slug that cannot be a site name;
 *   - after a 200: provisions the site in the background and tracks status.
 *
 * The org slug is the site id and therefore the subdomain: `acme` -> acme.<domain>.
 */
import { Kysely, sql } from "kysely";
import { siteDialect, runAsSite } from "./dialect.ts";
import { isSiteId } from "./rewrite.ts";
import { scopeState } from "./scope.ts";
import { provisionWith } from "./provision.ts";

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

const statusKey = (slug: string) => `multisite:site:${slug}`;

/** Control-plane connection: the shared inner driver, site resolved per query. */
function controlDb(): Kysely<never> {
	const st = scopeState();
	if (!st.inner) throw new Error("[multisite] database not initialised yet");
	return new Kysely<never>({ dialect: siteDialect(st.inner, st.activeSite, st.primary) });
}

export async function readStatus(slug: string): Promise<SiteStatus | null> {
	const db = controlDb();
	const row = await runAsSite(scopeState().primary, () =>
		sql<{ value: string }>`SELECT value FROM options WHERE name = ${statusKey(slug)}`.execute(db),
	);
	const v = row.rows[0]?.value;
	return v ? (JSON.parse(v) as SiteStatus) : null;
}

async function writeStatus(slug: string, s: SiteStatus): Promise<void> {
	const db = controlDb();
	await runAsSite(scopeState().primary, () =>
		sql`INSERT INTO options (name, value) VALUES (${statusKey(slug)}, ${JSON.stringify(s)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db),
	);
}

interface CreatedOrg {
	id?: string;
	slug?: string;
	name?: string;
	members?: Array<{ userId?: string; role?: string }>;
}

const BA_SETTINGS = "plugin:better-auth-settings:settings:";
/** Settings not inherited by customer sites: they decide for themselves. */
const NOT_INHERITED = new Set([`${BA_SETTINGS}orgEnabled`, `${BA_SETTINGS}teamsEnabled`]);

/**
 * Create the site `slug` and hand it to `ownerUserId`. Idempotent: running it
 * again on a half-provisioned site completes it.
 */
export async function createSiteForOrg(org: { slug: string; name: string; ownerUserId: string }): Promise<void> {
	const st = scopeState();
	const startedAt = new Date().toISOString();
	await writeStatus(org.slug, { status: "provisioning", startedAt });
	try {
		const db = controlDb();

		// 1. the site's tables (core migrations, run as the new site)
		await provisionWith(db, org.slug);

		// 2. read the owner's identity and platform auth policy from the control plane
		const { owner, storage, inherited } = await runAsSite(st.primary, async () => {
			const u = await sql<Record<string, unknown>>`SELECT * FROM users WHERE id = ${org.ownerUserId}`.execute(db);
			const s = await sql<Record<string, unknown>>`
				SELECT * FROM _plugin_storage
				WHERE collection IN ('accounts', 'usernames') AND data LIKE ${`%"userId":"${org.ownerUserId}"%`}`.execute(db);
			const o = await sql<{ name: string; value: string }>`
				SELECT name, value FROM options WHERE name LIKE ${`${BA_SETTINGS}%`}`.execute(db);
			return { owner: u.rows[0], storage: s.rows, inherited: o.rows.filter((r) => !NOT_INHERITED.has(r.name)) };
		});
		if (!owner) throw new Error(`owner ${org.ownerUserId} not found on the control plane`);

		// 3. write them into the new site: owner becomes admin (role 50), verified
		await runAsSite(org.slug, async () => {
			await sql`INSERT INTO users (id, email, name, avatar_url, role, email_verified, data, created_at, updated_at, disabled)
				VALUES (${owner.id}, ${owner.email}, ${owner.name}, ${owner.avatar_url}, 50, 1, ${owner.data},
					${owner.created_at}, ${owner.updated_at}, 0)
				ON CONFLICT(id) DO UPDATE SET role = 50, email_verified = 1`.execute(db);
			for (const r of storage) {
				await sql`INSERT INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at, revision)
					VALUES (${r.plugin_id}, ${r.collection}, ${r.id}, ${r.data}, ${r.created_at}, ${r.updated_at}, ${r.revision})
					ON CONFLICT(plugin_id, collection, id) DO NOTHING`.execute(db);
			}
			for (const r of inherited) {
				await sql`INSERT INTO options (name, value) VALUES (${r.name}, ${r.value})
					ON CONFLICT(name) DO NOTHING`.execute(db);
			}
			await sql`INSERT INTO options (name, value) VALUES ('site:title', ${JSON.stringify(org.name)})
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
			// The site is born with an admin (the owner, above), so EmDash's
			// first-run setup wizard must never run on it. Without this flag the
			// wizard appears and then refuses ("admin user already exists").
			await sql`INSERT INTO options (name, value) VALUES ('emdash:setup_complete', 'true')
				ON CONFLICT(name) DO UPDATE SET value = 'true'`.execute(db);
		});

		await writeStatus(org.slug, { status: "ready", startedAt, readyAt: new Date().toISOString() });
	} catch (error) {
		console.error(`[multisite] provisioning "${org.slug}" failed:`, error);
		await writeStatus(org.slug, {
			status: "failed",
			startedAt,
			error: error instanceof Error ? error.message : String(error),
		}).catch(() => {});
	}
}

export const ORG_CREATE_PATH = "/api/auth/organization/create";

/** Pull the fields provisioning needs out of Better Auth's create-org response. */
export function parseCreatedOrg(body: unknown): { slug: string; name: string; ownerUserId: string } | null {
	const o = body as CreatedOrg | null;
	const owner = o?.members?.find((m) => m.role === "owner") ?? o?.members?.[0];
	if (!o?.slug || !o.name || !owner?.userId) return null;
	return { slug: o.slug, name: o.name, ownerUserId: owner.userId };
}
