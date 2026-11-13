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
import { Button, Card, Chip, Input, ProgressBar, Skeleton, buttonVariants } from "@heroui/react";
// @ts-ignore - provided by the host (peer dependency)
import * as React from "react";
// `txt`, not `t`: this file already uses `t` (looks, timers) and `msg` (ChangeLook state) as local names.
import { matchLocale, resolveLocale, setLocale, t as txt, tn, type MessageKey } from "./i18n.ts";
// @ts-ignore - Astro virtual module (i18n is undefined when the host configures no i18n)
import { i18n as astroI18n } from "astro:config/client";

// Until /api/multisite/me answers (it carries the deployment's locale), use the Astro i18n default.
setLocale(resolveLocale(undefined, (astroI18n as { defaultLocale?: string } | undefined)?.defaultLocale));

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
	/** Active plan name (lowercased), or null for the free tier. */
	plan: string | null;
	/** Billing is on, so the Upgrade link resolves (otherwise /account/billing 404s). */
	canUpgrade: boolean;
	/** The deployment's locale (`SitesConfig.locale` or the i18n default). */
	locale?: string;
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
/** Display label for a plan name; null (no subscription) reads as "Free". */
const planLabel = (plan: string | null): string => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : txt("account.plan.free"));
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

/** Shimmer while data loads: same footprint as the real cards. */
const bone = (cls: string) => h(Skeleton, { className: cls });
function SitesSkeleton() {
	return h("div", { "aria-hidden": true, style: { display: "grid", gap: 16 } },
		h("div", { style: { display: "flex", justifyContent: "space-between" } }, bone("h-7 w-32 rounded-lg"), bone("h-9 w-24 rounded-full")),
		h("div", { style: grid(300) }, ...[0, 1].map((i) => h(Card, { key: i }, h(Card.Content, { style: { display: "grid", gap: 10 } },
			bone("h-[170px] w-full rounded-xl"), bone("h-5 w-40 rounded-lg"), bone("h-4 w-56 rounded-lg"), bone("h-9 w-32 rounded-full"))))));
}
function LookSkeleton() {
	return h("div", { "aria-hidden": true, style: grid(220) }, ...[0, 1, 2, 3].map((i) => h("div", { key: i, style: { display: "grid", gap: 8 } }, bone("h-[130px] w-full rounded-xl"), bone("h-4 w-28 rounded-lg"), bone("h-3 w-40 rounded-lg"))));
}

/** Pick a look: big cards with a picture. Used by the create flow and by Change look. */
function LookPicker(props: { looks: Look[]; value: string; onChange: (id: string) => void }) {
	return h("div", { role: "radiogroup", "aria-label": txt("account.look.label"), style: grid(220) },
		...props.looks.map((t) => {
			const on = props.value === t.id;
			return h("div", { key: t.id, style: { display: "grid", gap: 6 } },
				h("button", { type: "button", role: "radio", "aria-checked": on, onClick: () => props.onChange(t.id),
					style: { all: "unset", cursor: "pointer", display: "block", borderRadius: 14, outline: on ? "3px solid var(--accent, #2563eb)" : "1px solid rgba(127,127,127,.3)", outlineOffset: 2, padding: 8 } },
					h(Shot, { look: t }),
					h("div", { style: { padding: "8px 4px 2px" } },
						h("strong", null, t.pitch ? t.pitch.split(":")[0] : t.name), t.current ? h(Chip, { size: "sm", color: "accent", variant: "soft", style: { marginLeft: 8 } }, txt("account.look.current")) : null,
						h("p", { style: muted }, t.pitch?.includes(":") ? t.pitch.split(":").slice(1).join(":").trim() : t.description),
						!t.current && (t.adds?.length || t.hides?.length)
							? h("p", { style: { ...muted, fontSize: 12 } }, [t.adds?.length ? txt("account.look.adds", { list: t.adds.join(", ") }) : "", t.hides?.length ? txt("account.look.hides", { list: t.hides.join(", ") }) : ""].filter(Boolean).join("; "))
							: null)),
				t.demoUrl ? h("a", { href: t.demoUrl, target: "_blank", rel: "noopener", style: { fontSize: 14, paddingLeft: 12 } }, txt("account.look.preview")) : null);
		}));
}

const STEP_PERCENT: Record<string, number> = { queued: 8, tables: 35, content: 65, identity: 90, ready: 100 };
const STEP_TEXT: Record<string, MessageKey> = {
	queued: "account.step.queued",
	tables: "account.step.tables",
	content: "account.step.content",
	identity: "account.step.identity",
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
		setCheck({ ok: false, text: txt("account.wizard.checking"), url: "" });
		const mine = ++seq.current;
		const t = setTimeout(async () => {
			const r = await api(`/api/multisite/slug-check?slug=${encodeURIComponent(slug)}`);
			if (mine !== seq.current) return;
			setCheck(r.body?.available ? { ok: true, text: txt("account.wizard.free", { address: (r.body.url ?? slug).replace(/^https?:\/\//, "") }), url: r.body.url ?? "" } : { ok: false, text: r.body?.message ?? txt("account.wizard.taken"), url: "" });
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

	if (!props.me.emailVerified) return h("p", { role: "alert" }, txt("account.wizard.verifyEmail"));
	if (props.me.max !== null && props.me.owned >= props.me.max && !progress)
		return h("p", { role: "alert" }, tn("account.wizard.limit", props.me.max, { max: props.me.max, owned: props.me.owned }));

	if (progress?.status === "failed")
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 10 } },
			h("h2", { style: { margin: 0 } }, txt("account.wizard.failedTitle")),
			h("p", { style: muted }, txt("account.wizard.failedText")),
			h("div", null, h(Button, { variant: "primary", onPress: props.onDone }, txt("account.wizard.goToSites")))));
	if (progress?.status === "ready") {
		const base = chosen?.checklist ?? [];
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 14 } },
			h("div", null, h("h2", { style: { margin: 0 } }, txt("account.wizard.liveTitle")), h("p", { style: muted }, progress.name)),
			h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				h("a", { href: adminLink(progress.slug, "/_emdash/admin"), target: "_blank", rel: "noopener", className: linkBtn("primary") }, txt("account.wizard.edit")),
				check.url ? h("a", { href: check.url, target: "_blank", rel: "noopener", className: linkBtn("secondary") }, txt("account.wizard.view")) : null),
			base.length
				? h("div", { style: { display: "grid", gap: 8 } }, h("strong", null, txt("account.wizard.getStarted")),
						...base.map((c) => h("a", { key: c.path + c.label, href: adminLink(progress.slug, c.path), target: "_blank", rel: "noopener",
							style: { border: "1px solid rgba(127,127,127,.3)", borderRadius: 12, padding: "10px 12px", textDecoration: "none", color: "inherit" } }, txt("account.wizard.checklistItem", { label: c.label }))))
				: null,
			h("div", null, h(Button, { variant: "ghost", onPress: props.onDone }, txt("account.wizard.backToSites")))));
	}
	if (progress)
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 12 } },
			h("h2", { style: { margin: 0 } }, txt("account.wizard.building", { name: progress.name })),
			h(ProgressBar, { "aria-label": txt("account.wizard.buildingLabel"), value: STEP_PERCENT[progress.step] ?? 20 }, h(ProgressBar.Track, null, h(ProgressBar.Fill, null))),
			h("p", { role: "status", "aria-live": "polite", style: muted }, txt(STEP_TEXT[progress.step] ?? "account.wizard.almostThere"))));

	if (step === 1)
		return h("div", { style: { display: "grid", gap: 16 } },
			h("div", null, h("p", { style: { ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" } }, txt("account.wizard.step1")),
				h("h2", { style: { margin: 0 } }, txt("account.wizard.pickTitle")), h("p", { style: muted }, txt("account.wizard.pickText"))),
			h(LookPicker, { looks, value: look, onChange: setLook }),
			h("div", { style: { display: "flex", gap: 8 } }, h(Button, { variant: "primary", onPress: () => setStep(2) }, txt("account.wizard.continue")), h(Button, { variant: "ghost", onPress: props.onDone }, txt("account.wizard.cancel"))));

	const submit = async (e: Event) => {
		e.preventDefault();
		if (!check.ok || !name.trim()) return;
		setBusy(true);
		setError("");
		const r = await post("/api/auth/organization/create", { name: name.trim(), slug, ...(looks.length > 1 ? { metadata: { theme: look } } : {}) });
		setBusy(false);
		if (!r.ok) return setError(r.body?.message || r.body?.code || txt("account.wizard.createFailed", { status: r.status }));
		clean();
		setProgress({ slug, name: name.trim(), step: "tables", status: "provisioning" });
	};
	return h("form", { onSubmit: submit, style: { display: "grid", gap: 14, maxWidth: 520 } },
		h("div", null, h("p", { style: { ...muted, fontSize: 12, textTransform: "uppercase", letterSpacing: ".04em" } }, looks.length > 1 ? txt("account.wizard.step2") : txt("account.wizard.newSite")),
			h("h2", { style: { margin: 0 } }, txt("account.wizard.nameTitle")), h("p", { style: muted }, chosen ? txt("account.wizard.chosenLook", { name: chosen.pitch?.split(":")[0] ?? chosen.name }) : txt("account.wizard.nameText"))),
		h("label", { style: { display: "grid", gap: 4 } }, h("strong", null, txt("account.wizard.name")),
			h(Input, { value: name, "aria-label": txt("account.wizard.name"), placeholder: txt("account.wizard.namePlaceholder"), maxLength: 80, autoComplete: "off", fullWidth: true,
				onChange: (e: any) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); } })),
		h("label", { style: { display: "grid", gap: 4 } }, h("strong", null, txt("account.wizard.address")),
			h(Input, { value: slug, "aria-label": txt("account.wizard.address"), maxLength: 40, autoComplete: "off", fullWidth: true, "aria-describedby": "addr-msg",
				onChange: (e: any) => { setTouched(true); setSlug(slugify(e.target.value)); } }),
			h("span", { id: "addr-msg", "aria-live": "polite", style: { fontSize: 14, color: check.ok ? "#059669" : slug && check.text !== txt("account.wizard.checking") ? "#dc2626" : undefined, opacity: check.ok || slug ? 1 : 0.65 } }, check.ok ? txt("account.wizard.addressOk", { text: check.text }) : check.text || txt("account.wizard.addressHint"))),
		error ? h("p", { role: "alert", style: { color: "#dc2626", margin: 0 } }, error) : null,
		h("div", { style: { display: "flex", gap: 8 } },
			h(Button, { type: "submit", variant: "primary", isDisabled: busy || !check.ok || !name.trim() }, txt("account.wizard.submit")),
			looks.length > 1 && !wanted ? h(Button, { variant: "outline", onPress: () => setStep(1) }, txt("account.wizard.back")) : null,
			h(Button, { variant: "ghost", onPress: props.onDone }, txt("account.wizard.cancel"))));
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
	if (failed) return h("div", null, h("p", { role: "alert" }, txt("account.look.forbidden")), h(Button, { variant: "outline", onPress: props.onDone }, txt("account.look.back")));
	if (!state) return h(LookSkeleton);
	const looks: Look[] = state.themes.map((t: Look) => ({ ...t, demoUrl: demos[t.id] }));
	const submit = async (e: Event) => {
		e.preventDefault();
		setBusy(true);
		setMsg(txt("account.look.changing"));
		const r = await post(`/api/multisite/sites/${props.slug}/theme`, { theme: choice, includeContent: sample });
		if (!r.ok) {
			setBusy(false);
			return setMsg(r.body?.message || txt("account.look.failed"));
		}
		// The switch runs in the background (202): wait until the site really shows the new look.
		for (let i = 0; i < 60; i++) {
			await new Promise((res) => setTimeout(res, 1000));
			const a = await api(`/api/multisite/sites/${props.slug}/appearance`);
			if (a.ok && a.body.current === choice) {
				setBusy(false);
				setState({ ...state, current: choice, themes: state.themes.map((t: any) => ({ ...t, current: t.id === choice })) });
				return setMsg(txt("account.look.done"));
			}
		}
		setBusy(false);
		setMsg(txt("account.look.slow"));
	};
	return h("form", { onSubmit: submit, style: { display: "grid", gap: 16 } },
		h("div", null, h("h2", { style: { margin: 0 } }, txt("account.look.title", { name: state.name })),
			h("p", { style: muted }, txt("account.look.intro"))),
		h(LookPicker, { looks, value: choice, onChange: setChoice }),
		h("label", { style: { display: "flex", gap: 8, alignItems: "center" } }, h("input", { type: "checkbox", checked: sample, onChange: (e: any) => setSample(e.target.checked) }), txt("account.look.sample")),
		h("p", { role: "status", "aria-live": "polite", style: muted }, msg),
		h("div", { style: { display: "flex", gap: 8 } },
			h(Button, { type: "submit", variant: "primary", isDisabled: busy || choice === state.current }, txt("account.look.submit")),
			h(Button, { variant: "outline", isDisabled: busy, onPress: props.onDone }, txt("account.look.back"))));
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
	const chip = suspended ? [txt("account.card.paused"), "warning"] : s.status === "provisioning" ? [txt("account.card.settingUp"), "default"] : s.status === "failed" ? [txt("account.card.needsAttention"), "danger"] : [txt("account.card.live"), "success"];
	return h(Card, null,
		h(Card.Content, { style: { display: "grid", gap: 10 } },
			h(Shot, { look, height: 170 }),
			h("div", { style: { display: "flex", justifyContent: "space-between", gap: 8, alignItems: "start" } },
				h("div", { style: { minWidth: 0 } }, h("strong", { style: { fontSize: 17 } }, s.name),
					h("p", { style: { ...muted, overflowWrap: "anywhere" } }, (s.url ?? s.slug).replace(/^https?:\/\//, ""))),
				h(Chip, { size: "sm", color: chip[1], variant: "soft" }, chip[0])),
			suspended ? h("p", { style: { color: "#dc2626", margin: 0, fontSize: 14 } }, txt("account.card.pausedText")) : null,
			s.error ? h("p", { style: { color: "#dc2626", margin: 0, fontSize: 14 } }, s.error) : null,
			h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap" } },
				live ? h("a", { href: adminLink(s.slug, "/_emdash/admin"), target: "_blank", rel: "noopener", className: linkBtn("primary") }, txt("account.card.edit")) : null,
				live && s.url ? h("a", { href: s.url, target: "_blank", rel: "noopener", className: linkBtn("secondary") }, txt("account.card.view")) : null,
				s.canRetry ? h(Button, { variant: "primary", isDisabled: busy, onPress: () => run(() => post(`/api/multisite/sites/${s.slug}/retry`, {}), txt("account.card.retryFailed")) }, txt("account.card.retry")) : null),
			h("div", { style: { display: "flex", gap: 4, flexWrap: "wrap" } },
				live && me.themed && (s.role === "owner" || me.staff) ? h(Button, { size: "sm", variant: "ghost", onPress: () => props.onLook(s.slug) }, txt("account.card.changeLook")) : null,
				s.role === "owner"
					? h(Button, { size: "sm", variant: "ghost", isDisabled: busy, onPress: () => {
							if (confirm(txt("account.card.deleteConfirm", { name: s.name })))
								run(() => post(`/api/multisite/sites/${s.slug}/state`, { action: "delete" }), txt("account.card.deleteFailed"));
						} }, txt("account.card.delete")) : null)));
}

/** The control-plane (app) origin, for a tenant that must send the user "home" to manage sites. */
function appOrigin(): string {
	// The host injects it on the auth pages (Astro.locals.multisite.account is app-relative);
	// fall back to the registrable apex of the current host (drop the left-most label).
	try {
		const inj = (window as unknown as { __MULTISITE_APP_URL__?: string }).__MULTISITE_APP_URL__;
		if (inj) return inj;
		const h = window.location.hostname.split(".");
		return `${window.location.protocol}//${h.length > 2 ? h.slice(1).join(".") : h.join(".")}`;
	} catch {
		return "/";
	}
}

function SitesTab() {
	const [me, setMe] = React.useState(null as Me | null);
	const [looks, setLooks] = React.useState([] as Look[]);
	const [failed, setFailed] = React.useState(false);
	// A tenant site has no "my sites" feature — the `/api/multisite/me` route only exists on the
	// control plane (404 here). Show a link back to the app instead of a broken/empty list.
	const [tenant, setTenant] = React.useState(false);
	const [view, setView] = React.useState((qs("new") !== null ? { kind: "new" } : qs("appearance") ? { kind: "look", slug: qs("appearance") } : { kind: "list" }) as { kind: string; slug?: string });
	const timer = React.useRef(0 as any);
	const load = React.useCallback(async () => {
		clearTimeout(timer.current);
		const r = await api("/api/multisite/me");
		if (r.status === 404) return setTenant(true);
		if (!r.ok) return setFailed(true);
		const locale = matchLocale(r.body.locale);
		if (locale) setLocale(locale);
		setMe(r.body);
		if (r.body.sites.some((s: MySite) => s.status === "provisioning")) timer.current = setTimeout(load, 3000);
	}, []);
	React.useEffect(() => {
		load();
		api("/api/multisite/themes").then((r) => r.ok && setLooks(r.body.themes ?? []));
		return () => clearTimeout(timer.current);
	}, [load]);
	if (tenant)
		return h(Card, null, h(Card.Content, { style: { display: "grid", gap: 8, justifyItems: "start" } },
			h("h3", { style: { margin: 0 } }, txt("account.tenant.title")),
			h("p", { style: muted }, txt("account.tenant.text")),
			h("a", { href: `${appOrigin()}/account/sites`, className: linkBtn("primary") }, txt("account.tenant.link"))));
	if (failed) return h("p", { role: "alert" }, txt("account.list.loadFailed"));
	if (!me) return h(SitesSkeleton);
	const back = () => { clean(); setView({ kind: "list" }); load(); };
	if (view.kind === "new") return h(Wizard, { me, looks, onDone: back });
	if (view.kind === "look" && view.slug) return h(ChangeLook, { slug: view.slug, onDone: back });
	const full = me.max !== null && me.owned >= me.max;
	return h("div", { style: { display: "grid", gap: 16 } },
		h("div", { style: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" } },
			h("div", null, h("h2", { style: { margin: 0 } }, txt("account.list.title")),
				me.max !== null
					? h("p", { style: muted },
						tn("account.list.usage", me.max, { plan: planLabel(me.plan), owned: me.owned, max: me.max }),
						full && me.canUpgrade ? h("a", { href: "/account/billing", style: { marginLeft: 8 } }, txt("account.list.upgrade")) : null)
					: null),
			full ? null : h(Button, { variant: "primary", isDisabled: !me.emailVerified, onPress: () => setView({ kind: "new" }) }, txt("account.list.newSite"))),
		!me.emailVerified ? h("p", { style: muted }, txt("account.list.verifyEmail")) : null,
		me.sites.length === 0
			? h(Card, null, h(Card.Content, { style: { display: "grid", gap: 8, justifyItems: "start" } },
					h("h3", { style: { margin: 0 } }, txt("account.list.emptyTitle")), h("p", { style: muted }, txt("account.list.emptyText")),
					me.emailVerified ? h(Button, { variant: "primary", onPress: () => setView({ kind: "new" }) }, txt("account.list.createFirst")) : null))
			: h("div", { style: grid(300) },
					...me.sites.map((s: MySite) => h(SiteCard, { key: s.slug, s, me, look: looks.find((t: Look) => t.id === s.themeId), reload: load, onLook: (slug: string) => setView({ kind: "look", slug }) }))));
}

export const sitesPlugin = createAuthPlugin("multisite-sites", () => ({
	viewPaths: { settings: { sites: "sites" } },
	settingsTabs: [{ view: "sites", label: txt("account.tab"), component: SitesTab }],
}));
/** What `betterAuthUi({ plugins: "emdash-multisite/auth-ui" })` registers. */
// oxlint-disable-next-line typescript/no-explicit-any
const plugins: any[] = [sitesPlugin()];
export default plugins;
