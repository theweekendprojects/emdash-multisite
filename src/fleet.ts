/**
 * Fleet view for the hosting provider (super-admin).
 *
 * Read-only to start: list every site with its status, owner and user count.
 * The data lives in EmDash, not in Better Auth — the registry is control-plane
 * `options` rows (`multisite:site:<slug>`) + the Better Auth org/member records
 * in plugin storage + each site's own `users` table — so this is ours to serve,
 * gated to staff on the control-plane host.
 *
 * Staff = a user with EmDash role 50 (admin) on the CONTROL-PLANE site. That is
 * your account, not a tenant admin: tenant admins are role 50 only on their own
 * site's `users` table, which this never consults for the gate.
 */
import { Kysely, sql } from "kysely";
import { siteDialect, runAsSite } from "./dialect.ts";
import { isSiteId, isSiteTable } from "./rewrite.ts";
import { scopeState } from "./scope.ts";
import type { SiteStatus } from "./orgs.ts";
import { readAllStates } from "./registry.ts";

function controlDb(): Kysely<never> {
	const st = scopeState();
	if (!st.inner) throw new Error("[multisite] database not initialised yet");
	return new Kysely<never>({ dialect: siteDialect(st.inner, st.activeSite, st.primary) });
}

/**
 * Is `userId` a staff member? True only when they are role 50 on the
 * control-plane `users` table. `userId` comes from the EmDash session.
 */
export async function isStaff(userId: string | null | undefined): Promise<boolean> {
	if (!userId) return false;
	const db = controlDb();
	const row = await runAsSite(scopeState().primary, () =>
		sql<{ role: number }>`SELECT role FROM users WHERE id = ${userId}`.execute(db),
	);
	return (row.rows[0]?.role ?? 0) >= 50;
}

export interface FleetSite {
	slug: string;
	name: string;
	ownerEmail: string | null;
	status: SiteStatus["status"] | "unknown";
	/** active, or suspended / deleted by staff or the owner. */
	state: "active" | "suspended" | "deleted";
	createdAt: string | null;
	userCount: number;
}

/**
 * Every provisioned tenant site + the control plane itself. One pass over the
 * control-plane registry, then a per-site COUNT. Reads only; no tenant content.
 */
export async function listSites(): Promise<FleetSite[]> {
	const db = controlDb();
	const primary = scopeState().primary;

	return runAsSite(primary, async () => {
		// Which per-site tables physically exist -> the set of provisioned sites.
		const tables = await sql<{ name: string }>`
			SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'users$%' ESCAPE '\\'`.execute(db);
		// NOTE: translateRows strips the suffix from sqlite_master names for the
		// PRIMARY site; here we are the primary, so suffix stripping is OFF and we
		// see the real physical names. Guard anyway.
		const slugs = tables.rows
			.map((r) => r.name)
			.filter((n) => n.startsWith("users$"))
			.map((n) => n.slice("users$".length))
			.filter(isSiteId);

		// Org name/slug/createdAt + owner, from Better Auth storage on the primary.
		const orgs = await sql<{ data: string }>`
			SELECT data FROM _plugin_storage WHERE collection = 'organizations'`.execute(db);
		const members = await sql<{ data: string }>`
			SELECT data FROM _plugin_storage WHERE collection = 'members'`.execute(db);
		const states = await readAllStates();
		const statusRows = await sql<{ name: string; value: string }>`
			SELECT name, value FROM options WHERE name LIKE 'multisite:site:%'`.execute(db);

		const orgBySlug = new Map<string, { name: string; id: string; createdAt: string }>();
		for (const r of orgs.rows) {
			try {
				const o = JSON.parse(r.data) as { slug?: string; name?: string; id?: string; createdAt?: string };
				if (o.slug) orgBySlug.set(o.slug, { name: o.name ?? o.slug, id: o.id ?? "", createdAt: o.createdAt ?? "" });
			} catch {}
		}
		const ownerIdByOrgId = new Map<string, string>();
		for (const r of members.rows) {
			try {
				const m = JSON.parse(r.data) as { organizationId?: string; userId?: string; role?: string };
				if (m.organizationId && m.userId && m.role === "owner") ownerIdByOrgId.set(m.organizationId, m.userId);
			} catch {}
		}
		const statusBySlug = new Map<string, SiteStatus["status"]>();
		for (const r of statusRows.rows) {
			const slug = r.name.slice("multisite:site:".length);
			try {
				statusBySlug.set(slug, (JSON.parse(r.value) as SiteStatus).status);
			} catch {}
		}

		const out: FleetSite[] = [];
		// The control plane itself (unprefixed `users`), shown first.
		out.push({
			slug: primary,
			name: "(control plane)",
			ownerEmail: null,
			status: "ready",
			state: "active",
			createdAt: null,
			userCount: await countUsers(db, primary, primary),
		});

		for (const slug of slugs.sort()) {
			const org = orgBySlug.get(slug);
			const ownerId = org ? ownerIdByOrgId.get(org.id) : undefined;
			const ownerEmail = ownerId ? await emailOf(db, ownerId) : null;
			out.push({
				slug,
				name: org?.name ?? slug,
				ownerEmail,
				status: statusBySlug.get(slug) ?? "unknown",
				state: states.get(slug)?.state ?? "active",
				createdAt: org?.createdAt || null,
				userCount: await countUsers(db, slug, primary),
			});
		}
		return out;
	});
}

async function emailOf(db: Kysely<never>, userId: string): Promise<string | null> {
	const r = await sql<{ email: string }>`SELECT email FROM users WHERE id = ${userId}`.execute(db);
	return r.rows[0]?.email ?? null;
}

/** COUNT a site's own users table. `site` is validated; table name is built, never interpolated from input beyond that. */
async function countUsers(db: Kysely<never>, site: string, primary: string): Promise<number> {
	if (!isSiteId(site) || !isSiteTable("users")) return 0;
	// Run AS the site so the dialect rewrites `users` -> `users$site` for us.
	return runAsSite(site, async () => {
		try {
			const r = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM users`.execute(db);
			return Number(r.rows[0]?.c ?? 0);
		} catch {
			return 0;
		}
	});
}
