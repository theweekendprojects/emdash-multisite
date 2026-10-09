/**
 * "Sites" tab for Better Auth UI: the signed-in user's sites inside the account
 * page (`/account/sites`), next to Account and Security.
 *
 * Needs `emdash-better-auth` >= 0.10.0 (extension point for Better Auth UI
 * plugins). In the host:
 *
 *   // astro.config.mjs
 *   import { betterAuthUi } from "emdash-better-auth/vite";
 *   vite: { plugins: [betterAuthUi({ plugins: "emdash-multisite/auth-ui" })] }
 *
 * The component only calls this package's own JSON endpoints, so it carries no
 * Better Auth UI hooks and cannot clash with a second copy of that library.
 *
 * ponytail: plain React elements and inline styles, not HeroUI components. The
 * tab is a list of cards with links; HeroUI would need its Tailwind classes
 * scanned from this package. Upgrade path: swap the elements for HeroUI Card and
 * Button once the create wizard moves into the tab.
 */
// @ts-ignore - provided by the host (peer dependency)
import { createAuthPlugin } from "@better-auth-ui/core";
// @ts-ignore - provided by the host (peer dependency)
import * as React from "react";

interface MySite {
	slug: string;
	name: string;
	role: string;
	theme: string | null;
	status: string;
	state: "active" | "suspended";
	url: string | null;
	adminUrl: string | null;
	canRetry: boolean;
	error?: string;
}
interface Me {
	sites: MySite[];
	emailVerified: boolean;
	themed: boolean;
	staff: boolean;
	owned: number;
	max: number | null;
}

const h = React.createElement;
const border = "1px solid color-mix(in srgb, currentColor 18%, transparent)";
const muted = { opacity: 0.65, fontSize: 13, margin: "2px 0" } as const;
const btn = (primary = false) =>
	({
		display: "inline-block",
		padding: "6px 12px",
		borderRadius: 8,
		fontSize: 14,
		fontWeight: 600,
		textDecoration: "none",
		color: primary ? "#fff" : "inherit",
		background: primary ? "#2563eb" : "transparent",
		border: primary ? "1px solid #2563eb" : border,
	}) as const;

function SitesTab() {
	const [me, setMe] = React.useState(null as Me | null);
	const [failed, setFailed] = React.useState(false);

	React.useEffect(() => {
		let timer: ReturnType<typeof setTimeout>;
		let alive = true;
		const load = async () => {
			try {
				const res = await fetch("/api/multisite/me", { credentials: "same-origin", headers: { accept: "application/json" } });
				if (!res.ok) throw new Error(String(res.status));
				const data = (await res.json()) as Me;
				if (!alive) return;
				setMe(data);
				if (data.sites.some((s: MySite) => s.status === "provisioning")) timer = setTimeout(load, 4000);
			} catch {
				if (alive) setFailed(true);
			}
		};
		load();
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	}, []);

	if (failed) return h("p", { role: "alert" }, "Could not load your sites.");
	if (!me) return h("p", { style: muted }, "Loading\u2026");

	const atLimit = me.max !== null && me.owned >= me.max;
	return h(
		"div",
		{ style: { display: "grid", gap: 12 } },
		h(
			"div",
			{ style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" } },
			h("div", null, h("h2", { style: { margin: 0, fontSize: 18 } }, "Your sites"),
				me.max !== null ? h("p", { style: muted }, `${me.owned} of ${me.max} sites used`) : null),
			atLimit
				? null
				: h("a", { href: "/sites/new", style: btn(true), "aria-disabled": me.emailVerified ? undefined : "true" }, "Create site"),
		),
		!me.emailVerified ? h("p", { style: { ...muted, opacity: 1 } }, "Verify your email address to create sites.") : null,
		me.sites.length === 0 ? h("p", { style: muted }, "You have no sites yet.") : null,
		...me.sites.map((s: MySite) =>
			h(
				"article",
				{ key: s.slug, style: { border, borderRadius: 12, padding: 14 } },
				h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
					h("strong", null, s.name),
					h("span", { style: { fontSize: 12, fontWeight: 600 } }, s.state === "suspended" ? "suspended" : s.status === "provisioning" ? "setting up" : s.status)),
				h("p", { style: muted }, [s.slug, s.role, s.theme].filter(Boolean).join(" \u00b7 ")),
				s.error ? h("p", { style: { ...muted, color: "#dc2626", opacity: 1 } }, s.error) : null,
				h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 } },
					s.url && s.status === "ready" && s.state === "active"
						? [
								h("a", { key: "o", href: s.url, target: "_blank", rel: "noopener", style: btn() }, "Open site"),
								h("a", { key: "a", href: s.adminUrl ?? "#", target: "_blank", rel: "noopener", style: btn(true) }, "Open admin"),
							]
						: null,
					s.status === "ready" && s.state === "active" && me.themed && (s.role === "owner" || me.staff)
						? h("a", { href: `/sites/${s.slug}/appearance`, style: btn() }, "Appearance")
						: null,
					s.role === "owner" || s.canRetry ? h("a", { href: "/sites", style: btn() }, s.canRetry ? "Retry or manage" : "Manage") : null,
				),
			),
		),
	);
}

export const sitesPlugin = createAuthPlugin("multisite-sites", () => ({
	viewPaths: { settings: { sites: "sites" } },
	settingsTabs: [{ view: "sites", label: "Sites", component: SitesTab }],
}));

/** What `betterAuthUi({ plugins: "emdash-multisite/auth-ui" })` registers. */
// oxlint-disable-next-line typescript/no-explicit-any
const plugins: any[] = [sitesPlugin()];
export default plugins;
