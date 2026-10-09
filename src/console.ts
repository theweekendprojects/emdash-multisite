/**
 * Data behind the customer console (/sites, /sites/new): the signed-in user's
 * sites and whether they may create another. Read-only; creation itself goes
 * through Better Auth's organization/create so every rule in one place applies.
 */
import { isStaff } from "./fleet.ts";
import { isEmailVerified, readAllStatuses, readOrgs, readSiteTheme } from "./registry.ts";
import { DEFAULT_LIMITS, effectiveTheme, needsReconcile, slugProblem, switchSummary, themeFromMetadata, type SiteStatus } from "./rules.ts";
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
	/** Does the platform offer more than one theme? (Shows the Appearance action.) */
	themed: boolean;
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
		// The site's own option wins over the org metadata: it changes when the owner switches themes.
		const live = config.themes ? await readSiteTheme(org.slug) : null;
		const st = statuses.get(org.slug);
		const url = siteUrl(org.slug, config);
		sites.push({
			slug: org.slug,
			name: org.name,
			role: me.role,
			theme: config.themes ? (config.themes[effectiveTheme(live ?? themeFromMetadata(org.metadata), config.themes, config.defaultTheme)]?.name ?? null) : null,
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
		themed: Object.keys(config.themes ?? {}).length > 1,
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

/** May this user change the site's settings (theme)? The owner, or staff; the control plane is staff only. */
export async function canManage(userId: string, slug: string, primary: string): Promise<boolean> {
	if (await isStaff(userId)) return true;
	if (slug === primary) return false;
	const org = (await readOrgs()).find((o) => o.slug === slug);
	return org?.ownerUserId === userId;
}

export interface AppearanceState {
	slug: string;
	name: string;
	current: string;
	themes: Array<{ id: string; name: string; description: string; current: boolean; adds: string[]; hides: string[] }>;
}

/** The theme picker data for one site, with what each switch would add and hide. */
export async function appearanceState(slug: string, config: SitesConfig): Promise<AppearanceState | null> {
	if (!config.themes) return null;
	const org = (await readOrgs()).find((o) => o.slug === slug);
	if (!org && slug !== config.primary) return null;
	const current = effectiveTheme((await readSiteTheme(slug)) ?? themeFromMetadata(org?.metadata), config.themes, config.defaultTheme);
	return {
		slug,
		name: org?.name ?? slug,
		current,
		themes: Object.entries(config.themes).map(([id, t]) => ({
			id,
			name: t.name,
			description: t.description ?? "",
			current: id === current,
			...switchSummary(config.themes!, current, id),
		})),
	};
}
