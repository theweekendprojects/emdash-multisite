/**
 * "Sites" tab for Better Auth UI: the signed-in user's sites inside the account
 * page (`/account/sites`), next to Account and Security. Lists sites (open, change
 * theme, retry, delete) and holds the create-site wizard (`?new=1` opens it).
 *
 * Needs `emdash-better-auth` >= 0.10.0 (extension point for Better Auth UI
 * plugins). In the host:
 *
 *   // astro.config.mjs
 *   import { betterAuthUi } from "emdash-better-auth/vite";
 *   vite: { plugins: [betterAuthUi({ plugins: "emdash-multisite/auth-ui" })] }
 *
 * The component only calls this package's own JSON endpoints and Better Auth's
 * organization/create, so it carries no Better Auth UI hooks and cannot clash with
 * a second copy of that library.
 *
 * ponytail: plain React elements and inline styles, not HeroUI components. HeroUI
 * would need its Tailwind classes scanned from this package. Upgrade path: swap the
 * elements for HeroUI Card/Button/Input if the tab grows.
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
interface Theme {
	id: string;
	name: string;
	description: string;
	/** Public demo of the theme, when one exists. */
	demoUrl?: string;
}

const h = React.createElement;
const border = "1px solid color-mix(in srgb, currentColor 18%, transparent)";
const muted = { opacity: 0.65, fontSize: 13, margin: "2px 0" } as const;
const errorText = { color: "#dc2626", fontSize: 13, margin: "4px 0" } as const;
const btn = (kind: "plain" | "primary" | "danger" = "plain") =>
	({
		display: "inline-block",
		padding: "6px 12px",
		borderRadius: 8,
		fontSize: 14,
		fontWeight: 600,
		cursor: "pointer",
		textDecoration: "none",
		font: "inherit",
		color: kind === "primary" ? "#fff" : kind === "danger" ? "#dc2626" : "inherit",
		background: kind === "primary" ? "#2563eb" : "transparent",
		border: kind === "primary" ? "1px solid #2563eb" : kind === "danger" ? "1px solid #dc262666" : border,
	}) as const;
const input = {
	width: "100%",
	padding: "8px 10px",
	borderRadius: 8,
	border,
	background: "transparent",
	color: "inherit",
	font: "inherit",
	boxSizing: "border-box",
} as const;

async function api(url: string, init: RequestInit = {}) {
	const res = await fetch(url, {
		credentials: "same-origin",
		...init,
		headers: { accept: "application/json", ...(init.headers as Record<string, string>) },
	});
	let body: any = null;
	try {
		body = await res.json();
	} catch {}
	return { ok: res.ok, status: res.status, body };
}
const post = (url: string, data: unknown) =>
	api(url, {
		method: "POST",
		headers: { "content-type": "application/json", "x-emdash-request": "1" },
		body: JSON.stringify(data),
	});
const slugify = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Create-site wizard: name, address (live check), theme, then progress until ready. */
function Wizard(props: { me: Me; onDone: () => void }) {
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [touched, setTouched] = React.useState(false);
	const [check, setCheck] = React.useState({ ok: false, text: "" });
	const [themes, setThemes] = React.useState([] as Theme[]);
	const [theme, setTheme] = React.useState("");
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [progress, setProgress] = React.useState(null as null | { slug: string; name: string; step: string; status: string; error?: string });
	const seq = React.useRef(0);

	React.useEffect(() => {
		api("/api/multisite/themes").then((r) => {
			if (!r.ok) return;
			setThemes(r.body.themes ?? []);
			// `?theme=` comes from the "Use this theme" strip on a demo.
			const wanted = typeof location !== "undefined" ? new URLSearchParams(location.search).get("theme") : null;
			setTheme((r.body.themes ?? []).some((t: Theme) => t.id === wanted) ? wanted : r.body.default ?? "");
		});
	}, []);

	React.useEffect(() => {
		if (!slug) return setCheck({ ok: false, text: "" });
		setCheck({ ok: false, text: "Checking\u2026" });
		const mine = ++seq.current;
		const t = setTimeout(async () => {
			const r = await api(`/api/multisite/slug-check?slug=${encodeURIComponent(slug)}`);
			if (mine !== seq.current) return;
			setCheck(r.body?.available ? { ok: true, text: "Available." } : { ok: false, text: r.body?.message ?? "Not available." });
		}, 300);
		return () => clearTimeout(t);
	}, [slug]);

	React.useEffect(() => {
		if (!progress || progress.status === "ready" || progress.status === "failed") return;
		const t = setTimeout(async () => {
			const r = await api(`/api/multisite/sites/${progress.slug}`);
			if (r.ok && r.body) setProgress({ ...progress, status: r.body.status, step: r.body.step ?? progress.step, error: r.body.error });
			else setProgress({ ...progress });
		}, 2500);
		return () => clearTimeout(t);
	}, [progress]);

	if (progress) {
		const labels: Record<string, string> = {
			tables: "Creating your site\u2026",
			content: "Adding starter content\u2026",
			identity: "Setting up your account\u2026",
		};
		if (progress.status === "ready")
			return h("div", { style: { display: "grid", gap: 12 } },
				h("h2", { style: { margin: 0, fontSize: 18 } }, `${progress.name} is ready`),
				h("div", { style: { display: "flex", gap: 8 } },
					h("button", { style: btn("primary"), onClick: props.onDone }, "Back to my sites")));
		if (progress.status === "failed")
			return h("div", { style: { display: "grid", gap: 8 } },
				h("h2", { style: { margin: 0, fontSize: 18 } }, "Setup did not finish"),
				h("p", { style: errorText }, progress.error ?? ""),
				h("button", { style: btn("primary"), onClick: props.onDone }, "Go to my sites to retry"));
		return h("div", { style: { display: "grid", gap: 8 } },
			h("h2", { style: { margin: 0, fontSize: 18 } }, `Setting up ${progress.name}\u2026`),
			h("p", { role: "status", "aria-live": "polite", style: muted }, labels[progress.step] ?? "This takes about a minute."));
	}

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!check.ok || !name.trim()) return;
		setBusy(true);
		setError("");
		const r = await post("/api/auth/organization/create", {
			name: name.trim(),
			slug,
			...(themes.length > 1 ? { metadata: { theme } } : {}),
		});
		setBusy(false);
		if (!r.ok) return setError(r.body?.message || r.body?.code || `Could not create the site (HTTP ${r.status}).`);
		setProgress({ slug, name: name.trim(), step: "tables", status: "provisioning" });
	};

	if (!props.me.emailVerified) return h("p", { style: errorText }, "Verify your email address before creating a site.");
	if (props.me.max !== null && props.me.owned >= props.me.max)
		return h("p", { style: errorText }, `You own ${props.me.owned} of ${props.me.max} sites. That is the limit.`);

	return h("form", { onSubmit: submit, style: { display: "grid", gap: 12, maxWidth: 460 } },
		h("h2", { style: { margin: 0, fontSize: 18 } }, "Create a site"),
		h("label", null, h("div", { style: { fontWeight: 600, marginBottom: 4 } }, "Site name"),
			h("input", { value: name, maxLength: 80, required: true, autoComplete: "off", style: input,
				onChange: (e: any) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); } })),
		h("label", null, h("div", { style: { fontWeight: 600, marginBottom: 4 } }, "Address"),
			h("input", { value: slug, maxLength: 40, required: true, autoComplete: "off", style: input, "aria-describedby": "slug-msg",
				onChange: (e: any) => { setTouched(true); setSlug(slugify(e.target.value)); } }),
			h("p", { id: "slug-msg", "aria-live": "polite", style: { ...(check.ok ? { color: "#059669", fontSize: 13, margin: "4px 0" } : slug && check.text !== "Checking\u2026" ? errorText : muted) } }, check.text)),
		themes.length > 1
			? h("fieldset", { style: { border: 0, padding: 0, margin: 0, display: "grid", gap: 8 } },
					h("legend", { style: { fontWeight: 600, marginBottom: 6, padding: 0 } }, "Theme"),
					...themes.map((t: Theme) =>
						h("label", { key: t.id, style: { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
								border: theme === t.id ? "1px solid #2563eb" : border, boxShadow: theme === t.id ? "0 0 0 1px #2563eb" : "none" } },
							h("input", { type: "radio", name: "theme", value: t.id, checked: theme === t.id, onChange: () => setTheme(t.id), style: { marginTop: 4 } }),
							h("span", null, h("strong", null, t.name), h("small", { style: { display: "block", opacity: 0.65 } }, t.description),
								t.demoUrl ? h("a", { href: t.demoUrl, target: "_blank", rel: "noopener", style: { fontSize: 13 }, onClick: (e: any) => e.stopPropagation() }, "Preview \u2197") : null))))
			: null,
		error ? h("p", { role: "alert", style: errorText }, error) : null,
		h("div", { style: { display: "flex", gap: 8 } },
			h("button", { type: "submit", disabled: busy || !check.ok || !name.trim(), style: { ...btn("primary"), opacity: busy || !check.ok || !name.trim() ? 0.5 : 1 } }, "Create site"),
			h("button", { type: "button", style: btn(), onClick: props.onDone }, "Cancel")));
}

function SiteCard(props: { s: MySite; me: Me; reload: () => void; onAppearance: (slug: string) => void }) {
	const { s, me } = props;
	const [busy, setBusy] = React.useState(false);
	const suspended = s.state === "suspended";
	const run = async (fn: () => Promise<{ ok: boolean; body: any }>, fail: string) => {
		setBusy(true);
		const r = await fn();
		setBusy(false);
		if (!r.ok) alert(r.body?.message || r.body?.code || fail);
		props.reload();
	};
	return h("article", { style: { border, borderRadius: 12, padding: 14 } },
		h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8 } },
			h("strong", null, s.name),
			h("span", { style: { fontSize: 12, fontWeight: 600 } }, suspended ? "suspended" : s.status === "provisioning" ? "setting up" : s.status)),
		h("p", { style: muted }, [s.slug, s.role, s.theme].filter(Boolean).join(" \u00b7 ")),
		suspended ? h("p", { style: errorText }, "This site is suspended. Contact support to restore it.") : null,
		s.error ? h("p", { style: errorText }, s.error) : null,
		h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 } },
			s.url && s.status === "ready" && !suspended
				? [
						h("a", { key: "o", href: s.url, target: "_blank", rel: "noopener", style: btn() }, "Open site"),
						h("a", { key: "a", href: s.adminUrl ?? "#", target: "_blank", rel: "noopener", style: btn("primary") }, "Open admin"),
					]
				: null,
			s.status === "ready" && !suspended && me.themed && (s.role === "owner" || me.staff)
				? h("button", { style: btn(), onClick: () => props.onAppearance(s.slug) }, "Appearance")
				: null,
			s.canRetry
				? h("button", { disabled: busy, style: btn(), onClick: () => run(() => post(`/api/multisite/sites/${s.slug}/retry`, {}), "Could not retry.") }, "Retry setup")
				: null,
			s.role === "owner"
				? h("button", { disabled: busy, style: btn("danger"), onClick: () => {
						if (confirm(`Delete "${s.name}"? The site goes offline now. Support can restore it for a limited time.`))
							run(() => post(`/api/multisite/sites/${s.slug}/state`, { action: "delete" }), "Could not delete the site.");
					} }, "Delete")
				: null));
}

/** Appearance of one site: pick another theme (additive, nothing is deleted). Replaces the old standalone page. */
function Appearance(props: { slug: string; onDone: () => void }) {
	const [state, setState] = React.useState(null as any);
	const [demos, setDemos] = React.useState({} as Record<string, string>);
	const [choice, setChoice] = React.useState("");
	const [sample, setSample] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [msg, setMsg] = React.useState("");
	const [failed, setFailed] = React.useState(false);
	React.useEffect(() => {
		api(`/api/multisite/sites/${props.slug}/appearance`).then((r) => {
			if (!r.ok) return setFailed(true);
			setState(r.body);
			setChoice(r.body.current);
		});
		api("/api/multisite/themes").then((r) => {
			if (r.ok) setDemos(Object.fromEntries((r.body.themes ?? []).filter((t: Theme) => t.demoUrl).map((t: Theme) => [t.id, t.demoUrl])));
		});
	}, [props.slug]);
	if (failed) return h("div", null, h("p", { role: "alert", style: errorText }, "You cannot change this site\u2019s appearance."), h("button", { style: btn(), onClick: props.onDone }, "Back"));
	if (!state) return h("p", { style: muted }, "Loading\u2026");
	const list = (xs: string[]) => xs.join(", ");
	const submit = async (e: any) => {
		e.preventDefault();
		setBusy(true);
		setMsg("Switching\u2026");
		const r = await post(`/api/multisite/sites/${props.slug}/theme`, { theme: choice, includeContent: sample });
		setBusy(false);
		if (!r.ok) return setMsg(r.body?.message || r.body?.code || "Could not switch the theme.");
		setState({ ...state, current: choice, themes: state.themes.map((t: any) => ({ ...t, current: t.id === choice })) });
		setMsg("Theme switched. It shows within a minute.");
	};
	return h("form", { onSubmit: submit, style: { display: "grid", gap: 12 } },
		h("div", null, h("h2", { style: { margin: 0, fontSize: 18 } }, `Appearance \u00b7 ${state.name}`),
			h("p", { style: muted }, "Switching keeps all of your content. Anything the new theme does not show is hidden, and comes back if you switch back.")),
		h("fieldset", { style: { border: 0, padding: 0, margin: 0, display: "grid", gap: 8 } },
			h("legend", { style: { fontWeight: 600, marginBottom: 6, padding: 0 } }, "Theme"),
			...state.themes.map((t: any) =>
				h("label", { key: t.id, style: { display: "flex", gap: 10, alignItems: "flex-start", padding: "10px 12px", borderRadius: 10, cursor: "pointer",
						border: choice === t.id ? "1px solid #2563eb" : border, boxShadow: choice === t.id ? "0 0 0 1px #2563eb" : "none" } },
					h("input", { type: "radio", name: "theme", value: t.id, checked: choice === t.id, onChange: () => setChoice(t.id), style: { marginTop: 4 } }),
					h("span", null, h("strong", null, t.name + (t.current ? " (current)" : "")), h("small", { style: { display: "block", opacity: 0.65 } }, t.description),
						!t.current && t.adds.length ? h("small", { style: { display: "block", opacity: 0.65 } }, `Adds: ${list(t.adds)}`) : null,
						!t.current && t.hides.length ? h("small", { style: { display: "block", opacity: 0.65 } }, `Hides: ${list(t.hides)}`) : null,
						demos[t.id] ? h("a", { href: demos[t.id], target: "_blank", rel: "noopener", style: { fontSize: 13 }, onClick: (e: any) => e.stopPropagation() }, "Preview \u2197") : null)))),
		h("label", { style: { display: "flex", gap: 8, alignItems: "center", fontSize: 14 } },
			h("input", { type: "checkbox", checked: sample, onChange: (e: any) => setSample(e.target.checked) }), "Add sample content for any new sections"),
		h("p", { role: "status", "aria-live": "polite", style: muted }, msg),
		h("div", { style: { display: "flex", gap: 8 } },
			h("button", { type: "submit", disabled: busy || choice === state.current, style: { ...btn("primary"), opacity: busy || choice === state.current ? 0.5 : 1 } }, "Switch theme"),
			h("button", { type: "button", style: btn(), onClick: props.onDone }, "Back")));
}
function SitesTab() {
	const [me, setMe] = React.useState(null as Me | null);
	const [failed, setFailed] = React.useState(false);
	const [creating, setCreating] = React.useState(
		typeof location !== "undefined" && new URLSearchParams(location.search).has("new"),
	);
	// `?appearance=<slug>` opens a site's theme picker directly (the site admin links here).
	const [appearance, setAppearance] = React.useState(
		(typeof location !== "undefined" && new URLSearchParams(location.search).get("appearance")) || (null as string | null),
	);
	const timer = React.useRef(0 as any);

	const load = React.useCallback(async () => {
		clearTimeout(timer.current);
		const r = await api("/api/multisite/me");
		if (!r.ok) return setFailed(true);
		setMe(r.body);
		if (r.body.sites.some((s: MySite) => s.status === "provisioning")) timer.current = setTimeout(load, 4000);
	}, []);
	React.useEffect(() => {
		load();
		return () => clearTimeout(timer.current);
	}, [load]);

	if (failed) return h("p", { role: "alert" }, "Could not load your sites.");
	if (!me) return h("p", { style: muted }, "Loading\u2026");
	if (appearance) return h(Appearance, { slug: appearance, onDone: () => { setAppearance(null); if (typeof history !== "undefined") history.replaceState(null, "", location.pathname); load(); } });
	if (appearance) return h(Appearance, { slug: appearance, onDone: () => { setAppearance(null); load(); } });
	if (creating) return h(Wizard, { me, onDone: () => { setCreating(false); load(); } });

	const atLimit = me.max !== null && me.owned >= me.max;
	return h("div", { style: { display: "grid", gap: 12 } },
		h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" } },
			h("div", null, h("h2", { style: { margin: 0, fontSize: 18 } }, "Your sites"),
				me.max !== null ? h("p", { style: muted }, `${me.owned} of ${me.max} sites used`) : null),
			atLimit ? null : h("button", { style: { ...btn("primary"), opacity: me.emailVerified ? 1 : 0.5 }, disabled: !me.emailVerified, onClick: () => setCreating(true) }, "Create site")),
		!me.emailVerified ? h("p", { style: muted }, "Verify your email address to create sites.") : null,
		me.sites.length === 0 ? h("p", { style: muted }, "You have no sites yet.") : null,
		...me.sites.map((s: MySite) => h(SiteCard, { key: s.slug, s, me, reload: load, onAppearance: setAppearance })));
}

export const sitesPlugin = createAuthPlugin("multisite-sites", () => ({
	viewPaths: { settings: { sites: "sites" } },
	settingsTabs: [{ view: "sites", label: "Sites", component: SitesTab }],
}));

/** What `betterAuthUi({ plugins: "emdash-multisite/auth-ui" })` registers. */
// oxlint-disable-next-line typescript/no-explicit-any
const plugins: any[] = [sitesPlugin()];
export default plugins;
