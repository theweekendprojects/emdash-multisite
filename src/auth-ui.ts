/**
 * "Sites" tab for Better Auth UI: the signed-in user's sites inside the account page (`/account/sites`).
 * Built with HeroUI v3 (the library Better Auth UI itself uses, so it looks like the sign-in and account pages) in plain words for
 * people who are not technical: a card per site with a picture, Edit and View as the two main buttons, a four-step-feel create
 * flow (pick what you want to make, name it, wait, "what next"), and a Change look view. See emdash-plan/product/multisite-onboarding-ux.md.
 *
 * Needs `emdash-better-auth` >= 0.10.0 (extension point for Better Auth UI plugins). In the host:
 *
 *   // astro.config.mjs
 *   import { betterAuthUi } from "emdash-better-auth/vite";
 *   vite: { plugins: [betterAuthUi({ plugins: "emdash-multisite/auth-ui" })] }
 *
 * It only calls this package's own JSON endpoints and Better Auth's organization/create. `@heroui/react` is a peer dependency of
 * the host (the same copy Better Auth UI uses).
 */
// @ts-ignore - provided by the host (peer dependency)
import { createAuthPlugin } from "@better-auth-ui/core";
// @ts-ignore - provided by the host (peer dependency)
import { Button, Card, Chip, Input, ProgressBar, buttonVariants } from "@heroui/react";
// @ts-ignore - provided by the host (peer dependency)
import * as React from "react";

interface MySite {
	slug: string;
	name: string;
	role: string;
	theme: string | null;
	themeId: string | null;
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
interface Look {
	id: string;
	name: string;
	description: string;
	pitch?: string;
	preview?: string;
	demoUrl?: string;
	checklist?: Array<{ label: string; path: string }>;
	current?: boolean;
	adds?: string[];
	hides?: string[];
}

const h = React.createElement;
const grid = (min: number) => ({ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 16 }) as const;
const muted = { opacity: 0.65, fontSize: 14, margin: 0 } as const;
const linkBtn = (variant: string) => buttonVariants({ variant });

async function api(url: string, init: RequestInit = {}) {
	const res = await fetch(url, { credentials: "same-origin", ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string>) } });
	let body: any = null;
	try {
		body = await res.json();
	} catch {}
	return { ok: res.ok, status: res.status, body };
}
const post = (url: string, data: unknown) =>
	api(url, { method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1" }, body: JSON.stringify(data) });
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const qs = (key: string) => (typeof location !== "undefined" ? new URLSearchParams(location.search).get(key) : null);
const clean = () => typeof history !== "undefined" && history.replaceState(null, "", location.pathname);
/** Deep link into a site's own admin, through the one-click sign-in. */
const adminLink = (slug: string, path: string) => `/sites/${slug}/open-admin?next=${encodeURIComponent(path)}`;

/** A picture of a look (a screenshot of its demo). */
function Shot(props: { look?: Look; height?: number }) {
	const src = props.look?.preview;
	return h("div", { style: { ...(props.height ? { height: props.height } : { aspectRatio: "16 / 10" }), overflow: "hidden", borderRadius: 10, background: "rgba(127,127,127,.12)" } },
		src ? h("img", { src, alt: "", loading: "lazy", style: { width: "100%", height: "100%", objectFit: "cover", objectPosition: "top", display: "block" } }) : null);
}

/** Pick a look: big cards with a picture. Used by the create flow and by Change look. */
function LookPicker(props: { looks: Look[]; value: string; onChange: (id: string) => void }) {
	return h("div", { role: "radiogroup", "aria-label": "Look", style: grid(220) },
		...props.looks.map((t) => {
			const on = props.value === t.id;
			return h("div", { key: t.id, style: { display: "grid", gap: 6 } },
				h("button", { type: "button", role: "radio", "aria-checked": on, onClick: () => props.onChange(t.id),
					style: { all: "unset", cursor: "pointer", display: "block", borderRadius: 14, outline: on ? "3px solid var(--accent, #2563eb)" : "1px solid rgba(127,127,127,.3)", outlineOffset: 2, padding: 8 } },
					h(Shot, { look: t }),
					h("div", { style: { padding: "8px 4px 2px" } },
						h("strong", null, t.pitch ? t.pitch.split(":")[0] : t.name), t.current ? h(Chip, { size: "sm", color: "accent", variant: "soft", style: { marginLeft: 8 } }, "Current") : null,
						h("p", { style: muted }, t.pitch?.includes(":") ? t.pitch.split(":").slice(1).join(":").trim() : t.description),
						!t.current && (t.adds?.length || t.hides?.length)
							? h("p", { style: { ...muted, fontSize: 12 } }, [t.adds?.length ? `Adds ${t.adds.join(", ")}` : "", t.hides?.length ? `hides ${t.hides.join(", ")}` : ""].filter(Boolean).join("; "))
							: null)),
				t.demoUrl ? h("a", { href: t.demoUrl, target: "_blank", rel: "noopener", style: { fontSize: 14, paddingLeft: 12 } }, "Preview \u2197") : null);
		}));
}

const STEP_PERCENT: Record<string, number> = { queued: 8, tables: 35, content: 65, identity: 90, ready: 100 };
const STEP_TEXT: Record<string, string> = {
	queued: "Lots of people are building right now. You are next\u2026",
	tables: "Creating your site\u2026",
	content: "Adding your starter pages\u2026",
	identity: "Setting up your account\u2026",
};

/** Create a site: pick what to make, name it, wait, then "what next". */
function Wizard(props: { me: Me; looks: Look[]; onDone: () => void }) {
	const { looks } = props;
	const wanted = qs("theme");
	const [look, setLook] = React.useState(looks.some((t) => t.id === wanted) ? (wanted as string) : looks[0]?.id ?? "");
	const [step, setStep] = React.useState(looks.length > 1 && !wanted ? 1 : 2);
	const [name, setName] = React.useState("");
	const [slug, setSlug] = React.useState("");
	const [touched, setTouched] = React.useState(false);
	const [check, setCheck] = React.useState({ ok: false, text: "", url: "" });
	const [error, setError] = React.useState("");
	const [busy, setBusy] = React.useState(false);
	const [progress, setProgress] = React.useState(null as null | { slug: string; name: string; step: string; status: string; error?: string });
	const seq = React.useRef(0);
	const chosen = looks.find((t) => t.id === look);
	React.useEffect(() => {
		if (!slug) return setCheck({ ok: false, text: "", url: "" });
		setCheck({ ok: false, text: "Checking\u2026", url: "" });
		const mine = ++seq.current;
		const t = setTimeout(async () => {
			const r = await api(`/api/multisite/slug-check?slug=${encodeURIComponent(slug)}`);
			if (mine !== seq.current) return;
			setCheck(r.body?.available ? { ok: true, text: `${(r.body.url ?? slug).replace(/^https?:\/\//, "")} is free`, url: r.body.url ?? "" } : { ok: false, text: r.body?.message ?? "That address is taken. Try another.", url: "" });
		}, 300);
		return () => clearTimeout(t);
	}, [slug]);
	React.useEffect(() => {
		if (!progress || progress.status === "ready" || progress.status === "failed") return;
		const t = setTimeout(async () => {
			const r = await api(`/api/multisite/sites/${progress.slug}`);
			if (r.ok && r.body) setProgress({ ...progress, status: r.body.status, step: r.body.step ?? progress.step, error: r.body.error });
			else setProgress({ ...progress });
		}, 1500);
		return () => clearTimeout(t);
	}, [progress]);

	if (!props.me.emailVerified) return h("p", { role: "alert" }, "Please confirm your email address first. Then you can create your site.");
	if (props.me.max !== null && props.me.owned >= props.me.max && !progress)
		return h("p", { role: "alert" }, `Your plan includes ${props.me.max} site${props.me.max === 1 ? "" : "s"}, and you have ${props.me.owned}.`);

	if (progress?.status === "failed")
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 10 } },
			h("h2", { style: { margin: 0 } }, "That did not finish"),
			h("p", { style: muted }, "Nothing is lost. Go to your sites and press Try again."),
			h("div", null, h(Button, { variant: "primary", onPress: props.onDone }, "Go to my sites"))));
	if (progress?.status === "ready") {
		const base = chosen?.checklist ?? [];
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 14 } },
			h("div", null, h("h2", { style: { margin: 0 } }, "Your site is live"), h("p", { style: muted }, progress.name)),
			h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				h("a", { href: adminLink(progress.slug, "/_emdash/admin"), target: "_blank", rel: "noopener", className: linkBtn("primary") }, "Edit my site"),
				check.url ? h("a", { href: check.url, target: "_blank", rel: "noopener", className: linkBtn("secondary") }, "View my site") : null),
			base.length
				? h("div", { style: { display: "grid", gap: 8 } }, h("strong", null, "Get started"),
						...base.map((c) => h("a", { key: c.path + c.label, href: adminLink(progress.slug, c.path), target: "_blank", rel: "noopener",
							style: { border: "1px solid rgba(127,127,127,.3)", borderRadius: 12, padding: "10px 12px", textDecoration: "none", color: "inherit" } }, `${c.label} \u2192`)))
				: null,
			h("div", null, h(Button, { variant: "ghost", onPress: props.onDone }, "Back to my sites"))));
	}
	if (progress)
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 12 } },
			h("h2", { style: { margin: 0 } }, `Building ${progress.name}\u2026`),
			h(ProgressBar, { "aria-label": "Building your site", value: STEP_PERCENT[progress.step] ?? 20 }, h(ProgressBar.Track, null, h(ProgressBar.Fill, null))),
			h("p", { role: "status", "aria-live": "polite", style: muted }, STEP_TEXT[progress.step] ?? "Almost there\u2026")));

	if (step === 1)
		return h("div", { style: { display: "grid", gap: 16 } },
			h("div", null, h("p", { style: { ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" } }, "Step 1 of 2"),
				h("h2", { style: { margin: 0 } }, "What do you want to make?"), h("p", { style: muted }, "Pick a look. You can change it later and your content stays.")),
			h(LookPicker, { looks, value: look, onChange: setLook }),
			h("div", { style: { display: "flex", gap: 8 } }, h(Button, { variant: "primary", onPress: () => setStep(2) }, "Continue"), h(Button, { variant: "ghost", onPress: props.onDone }, "Cancel")));

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!check.ok || !name.trim()) return;
		setBusy(true);
		setError("");
		const r = await post("/api/auth/organization/create", { name: name.trim(), slug, ...(looks.length > 1 ? { metadata: { theme: look } } : {}) });
		setBusy(false);
		if (!r.ok) return setError(r.body?.message || r.body?.code || `Could not create the site (error ${r.status}).`);
		clean();
		setProgress({ slug, name: name.trim(), step: "tables", status: "provisioning" });
	};
	return h("form", { onSubmit: submit, style: { display: "grid", gap: 14, maxWidth: 520 } },
		h("div", null, h("p", { style: { ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" } }, looks.length > 1 ? "Step 2 of 2" : "New site"),
			h("h2", { style: { margin: 0 } }, "Name your site"), h("p", { style: muted }, chosen ? `Look: ${chosen.pitch?.split(":")[0] ?? chosen.name}` : "This is what visitors see. You can change it later.")),
		h("label", { style: { display: "grid", gap: 4 } }, h("strong", null, "Site name"),
			h(Input, { value: name, "aria-label": "Site name", placeholder: "My garden notes", maxLength: 80, autoComplete: "off", fullWidth: true,
				onChange: (e: any) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); } })),
		h("label", { style: { display: "grid", gap: 4 } }, h("strong", null, "Site address"),
			h(Input, { value: slug, "aria-label": "Site address", maxLength: 40, autoComplete: "off", fullWidth: true, "aria-describedby": "addr-msg",
				onChange: (e: any) => { setTouched(true); setSlug(slugify(e.target.value)); } }),
			h("span", { id: "addr-msg", "aria-live": "polite", style: { fontSize: 14, color: check.ok ? "#059669" : slug && check.text !== "Checking\u2026" ? "#dc2626" : undefined, opacity: check.ok || slug ? 1 : 0.65 } }, check.ok ? `\u2713 ${check.text}` : check.text || "Letters, numbers and dashes.")),
		error ? h("p", { role: "alert", style: { color: "#dc2626", margin: 0 } }, error) : null,
		h("div", { style: { display: "flex", gap: 8 } },
			h(Button, { type: "submit", variant: "primary", isDisabled: busy || !check.ok || !name.trim() }, "Create my site"),
			looks.length > 1 && !wanted ? h(Button, { variant: "outline", onPress: () => setStep(1) }, "Back") : null,
			h(Button, { variant: "ghost", onPress: props.onDone }, "Cancel")));
}

/** Change the look of one site (nothing is deleted; the old look's content is hidden and comes back). */
function ChangeLook(props: { slug: string; onDone: () => void }) {
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
		api("/api/multisite/themes").then((r) => r.ok && setDemos(Object.fromEntries((r.body.themes ?? []).filter((t: Look) => t.demoUrl).map((t: Look) => [t.id, t.demoUrl]))));
	}, [props.slug]);
	if (failed) return h("div", null, h("p", { role: "alert" }, "You cannot change this site\u2019s look."), h(Button, { variant: "outline", onPress: props.onDone }, "Back"));
	if (!state) return h("p", { style: muted }, "Loading\u2026");
	const looks: Look[] = state.themes.map((t: Look) => ({ ...t, demoUrl: demos[t.id] }));
	const submit = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		setMsg("Changing the look\u2026");
		const r = await post(`/api/multisite/sites/${props.slug}/theme`, { theme: choice, includeContent: sample });
		setBusy(false);
		if (!r.ok) return setMsg(r.body?.message || "Could not change the look. Try again.");
		setState({ ...state, current: choice, themes: state.themes.map((t: any) => ({ ...t, current: t.id === choice })) });
		setMsg("Done. The new look shows within a minute. Your content is safe.");
	};
	return h("form", { onSubmit: submit, style: { display: "grid", gap: 16 } },
		h("div", null, h("h2", { style: { margin: 0 } }, `Change the look of ${state.name}`),
			h("p", { style: muted }, "Your content stays. Anything the new look does not show is hidden, and comes back if you switch back.")),
		h(LookPicker, { looks, value: choice, onChange: setChoice }),
		h("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("input", { type: "checkbox", checked: sample, onChange: (e: any) => setSample(e.target.checked) }), "Add example content for any new sections"),
		h("p", { role: "status", "aria-live": "polite", style: muted }, msg),
		h("div", { style: { display: "flex", gap: 8 } },
			h(Button, { type: "submit", variant: "primary", isDisabled: busy || choice === state.current }, "Use this look"),
			h(Button, { variant: "outline", onPress: props.onDone }, "Back")));
}

function SiteCard(props: { s: MySite; me: Me; look?: Look; reload: () => void; onLook: (slug: string) => void }) {
	const { s, me, look } = props;
	const [busy, setBusy] = React.useState(false);
	const suspended = s.state === "suspended";
	const live = s.status === "ready" && !suspended;
	const run = async (fn: () => Promise<{ ok: boolean; body: any }>, fail: string) => {
		setBusy(true);
		const r = await fn();
		setBusy(false);
		if (!r.ok) alert(r.body?.message || r.body?.code || fail);
		props.reload();
	};
	const chip = suspended ? ["Paused", "warning"] : s.status === "provisioning" ? ["Setting up", "default"] : s.status === "failed" ? ["Needs attention", "danger"] : ["Live", "success"];
	return h(Card, null,
		h(Card.Content, { style: { display: "grid", gap: 10 } },
			h(Shot, { look, height: 170 }),
			h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" } },
				h("div", { style: { minWidth: 0 } }, h("strong", { style: { fontSize: 17 } }, s.name),
					h("p", { style: { ...muted, overflowWrap: "anywhere" } }, (s.url ?? s.slug).replace(/^https?:\/\//, ""))),
				h(Chip, { size: "sm", color: chip[1], variant: "soft" }, chip[0])),
			suspended ? h("p", { style: { color: "#dc2626", margin: 0, fontSize: 14 } }, "This site is paused. Contact support to turn it back on.") : null,
			s.error ? h("p", { style: { color: "#dc2626", margin: 0, fontSize: 14 } }, s.error) : null,
			h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				live ? h("a", { href: adminLink(s.slug, "/_emdash/admin"), target: "_blank", rel: "noopener", className: linkBtn("primary") }, "Edit") : null,
				live && s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", className: linkBtn("secondary") }, "View") : null,
				s.canRetry ? h(Button, { variant: "primary", isDisabled: busy, onPress: () => run(() => post(`/api/multisite/sites/${s.slug}/retry`, {}), "Could not try again.") }, "Try again") : null),
			h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
				live && me.themed && (s.role === "owner" || me.staff) ? h(Button, { size: "sm", variant: "ghost", onPress: () => props.onLook(s.slug) }, "Change look") : null,
				s.role === "owner"
					? h(Button, { size: "sm", variant: "ghost", isDisabled: busy, onPress: () => {
							if (confirm(`Delete "${s.name}"? It goes offline now. Support can bring it back for a limited time.`))
								run(() => post(`/api/multisite/sites/${s.slug}/state`, { action: "delete" }), "Could not delete the site.");
						} }, "Delete") : null)));
}

function SitesTab() {
	const [me, setMe] = React.useState(null as Me | null);
	const [looks, setLooks] = React.useState([] as Look[]);
	const [failed, setFailed] = React.useState(false);
	const [view, setView] = React.useState((qs("new") !== null ? { kind: "new" } : qs("appearance") ? { kind: "look", slug: qs("appearance") } : { kind: "list" }) as { kind: string; slug?: string });
	const timer = React.useRef(0 as any);
	const load = React.useCallback(async () => {
		clearTimeout(timer.current);
		const r = await api("/api/multisite/me");
		if (!r.ok) return setFailed(true);
		setMe(r.body);
		if (r.body.sites.some((s: MySite) => s.status === "provisioning")) timer.current = setTimeout(load, 3000);
	}, []);
	React.useEffect(() => {
		load();
		api("/api/multisite/themes").then((r) => r.ok && setLooks(r.body.themes ?? []));
		return () => clearTimeout(timer.current);
	}, [load]);
	if (failed) return h("p", { role: "alert" }, "Could not load your sites. Please reload the page.");
	if (!me) return h("p", { style: muted }, "Loading\u2026");
	const back = () => { clean(); setView({ kind: "list" }); load(); };
	if (view.kind === "new") return h(Wizard, { me, looks, onDone: back });
	if (view.kind === "look" && view.slug) return h(ChangeLook, { slug: view.slug, onDone: back });
	const full = me.max !== null && me.owned >= me.max;
	return h("div", { style: { display: "grid", gap: 16 } },
		h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" } },
			h("div", null, h("h2", { style: { margin: 0 } }, "My sites"),
				me.max !== null ? h("p", { style: muted }, `${me.owned} of ${me.max} site${me.max === 1 ? "" : "s"} used`) : null),
			full ? null : h(Button, { variant: "primary", isDisabled: !me.emailVerified, onPress: () => setView({ kind: "new" }) }, "New site")),
		!me.emailVerified ? h("p", { style: muted }, "Confirm your email address to create a site.") : null,
		me.sites.length === 0
			? h(Card, null, h(Card.Content, { style: { display: "grid", gap: 8, justifyItems: "start" } },
					h("h3", { style: { margin: 0 } }, "You have no sites yet"), h("p", { style: muted }, "Make one in a minute: pick a look, give it a name, done."),
					me.emailVerified ? h(Button, { variant: "primary", onPress: () => setView({ kind: "new" }) }, "Create my first site") : null))
			: h("div", { style: grid(300) },
					...me.sites.map((s: MySite) => h(SiteCard, { key: s.slug, s, me, look: looks.find((t: Look) => t.id === s.themeId), reload: load, onLook: (slug: string) => setView({ kind: "look", slug }) }))));
}

export const sitesPlugin = createAuthPlugin("multisite-sites", () => ({
	viewPaths: { settings: { sites: "sites" } },
	settingsTabs: [{ view: "sites", label: "My sites", component: SitesTab }],
}));
/** What `betterAuthUi({ plugins: "emdash-multisite/auth-ui" })` registers. */
// oxlint-disable-next-line typescript/no-explicit-any
const plugins: any[] = [sitesPlugin()];
export default plugins;
