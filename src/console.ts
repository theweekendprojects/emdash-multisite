/**
 * Data behind the customer console (/sites, /sites/new): the signed-in user's
 * sites and whether they may create another. Read-only; creation itself goes
 * through Better Auth's organization/create so every rule in one place applies.
 */
import { isStaff } from "./fleet.ts";
import { isEmailVerified, readAllStatuses, readOrgs } from "./registry.ts";
import { DEFAULT_LIMITS, effectiveTheme, needsReconcile, slugProblem, themeFromMetadata, type SiteStatus } from "./rules.ts";
import { siteUrl, type SitesConfig } from "./sites.ts";

export interface MySite {
	slug: string;
	name: string;
	/** The user's Better Auth role in this org: owner, admin, member. */
	role: string;
	/** Theme display name, or null when the platform has a single bundled theme. */
	theme: string | null;
	status: SiteStatus["status"] | "unknown";
	error?: string;
	/** Public address, or null when no hostname is configured for the site. */
	url: string | null;
	/** The site's own EmDash admin. */
	adminUrl: string | null;
	/** Provisioning needs a push (failed, or a run that died) and the user may trigger it. */
	canRetry: boolean;
}

export interface ConsoleState {
	sites: MySite[];
	emailVerified: boolean;
	staff: boolean;
	/** Sites owned vs. the cap (`max` null = no cap). */
	owned: number;
	max: number | null;
}

export async function consoleState(userId: string, config: SitesConfig): Promise<ConsoleState> {
	const [orgs, statuses, emailVerified, staff] = await Promise.all([
		readOrgs(),
		readAllStatuses(),
		isEmailVerified(userId),
		isStaff(userId),
	]);
	const now = Date.now();
	const sites: MySite[] = [];
	for (const org of orgs) {
		const me = org.members.find((m) => m.userId === userId);
		if (!me) continue;
		const st = statuses.get(org.slug);
		const url = siteUrl(org.slug, config);
		sites.push({
			slug: org.slug,
			name: org.name,
			role: me.role,
			theme: config.themes ? (config.themes[effectiveTheme(themeFromMetadata(org.metadata), config.themes, config.defaultTheme)]?.name ?? null) : null,
			status: st?.status ?? "unknown",
			...(st?.status === "failed" ? { error: st.error } : {}),
			url,
			adminUrl: url ? `${url}/_emdash/admin` : null,
			canRetry: (me.role === "owner" || staff) && needsReconcile(st ?? null, now),
		});
	}
	sites.sort((a, b) => a.name.localeCompare(b.name));
	return {
		sites,
		emailVerified,
		staff,
		owned: sites.filter((s) => s.role === "owner").length,
		max: (config.limits ?? DEFAULT_LIMITS).sitesPerUser ?? null,
	};
}

/** Is this address free and allowed? Used for the live check in the wizard. */
export async function checkAddress(slug: unknown, primary: string): Promise<{ available: boolean; message: string | null }> {
	const problem = slugProblem(slug, primary);
	if (problem) return { available: false, message: problem };
	const taken = (await readOrgs()).some((o) => o.slug === slug);
	return taken ? { available: false, message: "That address is taken." } : { available: true, message: null };
}
