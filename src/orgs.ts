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
import { sql } from "kysely";
import { applySeed } from "emdash";
// @ts-ignore - virtual module provided by EmDash's integration (the bundled seed)
import { userSeed } from "virtual:emdash/seed";
import { runAsSite } from "./dialect.ts";
import { isSiteId } from "./rewrite.ts";
import { BUNDLED_THEME, STALE_PROVISIONING_MS, effectiveTheme, needsReconcile, themeFromMetadata, type SiteStatus } from "./rules.ts";
import type { SitesConfig } from "./sites.ts";
import { controlDb, forgetSiteTheme, readOrgs, readSiteTheme, siteHasTables } from "./registry.ts";
import { scopeState } from "./scope.ts";
import { provisionWith } from "./provision.ts";

export { ORG_CREATE_PATH, RESERVED_SITE_IDS, parseCreatedOrg, slugProblem, type SiteStatus } from "./rules.ts";

const statusKey = (slug: string) => `multisite:site:${slug}`;

export async function readStatus(slug: string): Promise<SiteStatus | null> {
	const db = controlDb();
	const row = await runAsSite(scopeState().primary, () =>
		sql<{ value: string }>`SELECT value FROM options WHERE name = ${statusKey(slug)}`.execute(db),
	);
	const v = row.rows[0]?.value;
	return v ? (JSON.parse(v) as SiteStatus) : null;
}

export async function writeStatus(slug: string, s: SiteStatus): Promise<void> {
	const db = controlDb();
	await runAsSite(scopeState().primary, () =>
		sql`INSERT INTO options (name, value) VALUES (${statusKey(slug)}, ${JSON.stringify(s)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db),
	);
}

const BA_SETTINGS = "plugin:better-auth-settings:settings:";
/** Settings not inherited by customer sites: they decide for themselves. */
const NOT_INHERITED = new Set([`${BA_SETTINGS}orgEnabled`, `${BA_SETTINGS}teamsEnabled`]);

/** Free core's migration lock if it has been held longer than a provisioning run can last. */
async function releaseStaleLock(db: ReturnType<typeof controlDb>, slug: string): Promise<void> {
	const cutoff = Date.now() - STALE_PROVISIONING_MS;
	await runAsSite(slug, () =>
		sql`UPDATE _emdash_migrations_lock SET is_locked = 0 WHERE is_locked > 0 AND is_locked < ${cutoff}`
			.execute(db)
			.catch(() => {}), // first run: the table does not exist yet
	);
}

/**
 * Create the site `slug` and hand it to `ownerUserId`. Idempotent: running it
 * again on a half-provisioned site completes it.
 */
export async function createSiteForOrg(
	org: { slug: string; name: string; ownerUserId: string },
	plan: { theme: string; seed?: unknown } = { theme: BUNDLED_THEME },
): Promise<void> {
	const st = scopeState();
	const startedAt = new Date().toISOString();
	await writeStatus(org.slug, { status: "provisioning", startedAt });
	try {
		const db = controlDb();

		// 0. a run that was killed mid-migration (Worker evicted) leaves core's
		//    migration lock held, and every retry then refuses to start. Release a
		//    lock old enough that its owner is certainly gone.
		await releaseStaleLock(db, org.slug);

		// 1. the site's tables (core migrations, run as the new site)
		await provisionWith(db, org.slug);

		// 1b. seed the new site with its theme's seed (collections + starter
		//     content), or the host's bundled seed when no themes are configured.
		//     Migrations alone leave an empty schema with no collections, so
		//     without this a new tenant has nothing to edit. core's applySeed
		//     upserts, so a retry is safe. Media is not downloaded: object
		//     storage is shared, not per-site (see AGENTS.md).
		const seed = plan.seed ?? userSeed;
		if (seed) {
			// eslint-disable-next-line typescript/no-explicit-any -- core types its own Database/Seed
			await runAsSite(org.slug, () => applySeed(db as any, seed as any, { includeContent: true, skipMediaDownload: true }));
		}

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
			await sql`INSERT INTO options (name, value) VALUES ('multisite:theme', ${JSON.stringify(plan.theme)})
				ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
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

/** Theme id and seed for a site, from what was requested at creation (org metadata). */
export function planFor(sites: SitesConfig, metadata: unknown): { theme: string; seed?: unknown } {
	const theme = effectiveTheme(themeFromMetadata(metadata), sites.themes, sites.defaultTheme);
	return { theme, seed: sites.themes?.[theme]?.seed };
}

/**
 * Sites that need provisioning (again): `failed`, a `provisioning` row old
 * enough to be a dead run, or no status row at all. A site with no status row
 * but with tables predates status tracking; it is adopted as `ready` instead of
 * being provisioned a second time on top of live content.
 */
export async function pendingReconcile(only?: string): Promise<string[]> {
	const out: string[] = [];
	for (const org of await readOrgs()) {
		if (only && org.slug !== only) continue;
		if (!org.ownerUserId || !isSiteId(org.slug)) continue;
		const status = await readStatus(org.slug);
		if (!needsReconcile(status, Date.now())) continue;
		if (!status && (await siteHasTables(org.slug))) {
			const now = new Date().toISOString();
			await writeStatus(org.slug, { status: "ready", startedAt: now, readyAt: now });
			continue;
		}
		out.push(org.slug);
	}
	return out;
}

/**
 * Re-provision ONE stuck site (the first pending, or `only`). One per call on
 * purpose: a run is ~20 s of D1 work and the background budget after a response
 * (`waitUntil`) is ~30 s, so a loop would be killed half way and leave a site
 * stuck in `provisioning`. Call again for the next one.
 * ponytail: upgrade path is a Queue or Workflow that runs one site per message.
 */
export async function reconcile(sites: SitesConfig, only?: string): Promise<string[]> {
	const [slug] = await pendingReconcile(only);
	if (!slug) return [];
	const org = (await readOrgs()).find((o) => o.slug === slug)!;
	// A switched site keeps its current theme; the org metadata only records the first choice.
	const current = await readSiteTheme(slug);
	await createSiteForOrg({ slug, name: org.name, ownerUserId: org.ownerUserId! }, planFor(sites, current ? { theme: current } : org.metadata));
	return [slug];
}

/**
 * Switch a live site to another theme. Additive and non-destructive: the target
 * theme's seed is applied with skip-on-conflict (core creates only what is
 * missing, never overwrites settings, menus or content), then the site's theme
 * option is flipped. Content of the old theme stays in the database, hidden.
 */
export async function switchTheme(
	sites: SitesConfig,
	slug: string,
	theme: string,
	opts: { includeContent: boolean },
): Promise<void> {
	const seed = sites.themes?.[theme]?.seed;
	if (!seed) throw new Error(`unknown theme: ${theme}`);
	const db = controlDb();
	await runAsSite(slug, async () => {
		// eslint-disable-next-line typescript/no-explicit-any -- core types its own Database/Seed
		await applySeed(db as any, seed as any, { includeContent: opts.includeContent, skipMediaDownload: true, onConflict: "skip" });
		await sql`INSERT INTO options (name, value) VALUES ('multisite:theme', ${JSON.stringify(theme)})
			ON CONFLICT(name) DO UPDATE SET value = excluded.value`.execute(db);
	});
	forgetSiteTheme(slug);
}
