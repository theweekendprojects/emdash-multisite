/**
 * The customer console HTML: "My sites" (/sites) and the create wizard
 * (/sites/new). Served by the middleware on the control-plane host to signed-in
 * users only; all data comes from /api/multisite/me and Better Auth.
 *
 * ponytail: plain HTML + vanilla JS, same as the fleet page, so the host build
 * needs no extra React island. Upgrade path: an injected .astro page + island
 * over the same JSON endpoints if the console grows past two screens.
 *
 * The client script avoids backticks and `${` on purpose: it lives inside a
 * template literal. Its strings come from src/i18n.ts (`console.*`), embedded as JSON.
 */
import { getLocale, messagesFor, tHtml } from "./i18n.ts";

const CLIENT_JS = String.raw`
(() => {
  const mode = document.body.dataset.mode;
  const root = document.getElementById("root");
  const nav = document.getElementById("nav");
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  // Messages: the console.* slice of src/i18n.ts, embedded by consolePageHtml.
  // Names chosen not to collide with the locals below (tr, msg, t, ok...).
  const MSG = JSON.parse(document.getElementById("multisite-i18n").textContent);
  const plural = new Intl.PluralRules(document.documentElement.lang || "en");
  const fillMsg = (text, p) => text.replace(/\{(\w+)\}/g, (m, n) => (p && Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m));
  const rawMsg = (k) => (MSG[k] == null ? k : MSG[k]);
  // txt: plain text (textContent, confirm, alert). htm: HTML; the message is escaped, params must already be HTML.
  const txt = (k, p) => fillMsg(rawMsg(k), p);
  const htm = (k, p) => fillMsg(esc(rawMsg(k)), p);
  const txtn = (k, n, p) => txt(k + (plural.select(n) === "one" ? ".one" : ".other"), Object.assign({ count: n }, p));
  const known = (prefix, v) => (MSG[prefix + v] == null ? esc(v) : htm(prefix + v));
  const status = (s) => '<span class="pill ' + esc(s) + '">' + known("console.status.", s) + '</span>';
  const getJson = async (url, init) => {
    const res = await fetch(url, Object.assign({ headers: { accept: "application/json" }, credentials: "same-origin" }, init));
    let body = null;
    try { body = await res.json(); } catch (e) {}
    return { ok: res.ok, status: res.status, body };
  };
  const toLogin = () => { location.href = "/login?redirect=" + encodeURIComponent(location.pathname); };

  const renderNav = (me) => {
    nav.innerHTML =
      '<a href="/sites"' + (mode === "list" ? ' aria-current="page"' : '') + '>' + htm("console.nav.sites") + '</a>' +
      '<a href="/organization">' + htm("console.nav.teams") + '</a>' +
      '<a href="/account">' + htm("console.nav.account") + '</a>' +
      (me && me.staff ? '<a href="/admin/fleet">' + htm("console.nav.fleet") + '</a>' : '');
  };

  // ---------- My sites ----------
  const siteCard = (s, staff, themed) => {
    const suspended = s.state === "suspended";
    const open = s.url && s.status === "ready" && !suspended
      ? '<a class="btn" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + htm("console.list.openSite") + '</a>' +
        '<a class="btn primary" href="' + esc(s.adminUrl) + '" target="_blank" rel="noopener">' + htm("console.list.openAdmin") + '</a>'
      : "";
    const noUrl = s.status === "ready" && !s.url ? '<p class="muted">' + htm("console.list.noUrl") + '</p>' : "";
    const err = s.error ? '<p class="errtext">' + esc(s.error) + '</p>' : "";
    const appearance = s.status === "ready" && !suspended && (s.role === "owner" || staff) && themed
      ? '<a class="btn" href="/sites/' + esc(s.slug) + '/appearance">' + htm("console.list.appearance") + '</a>' : "";
    const retry = s.canRetry ? '<button class="btn" data-retry="' + esc(s.slug) + '">' + htm("console.list.retry") + '</button>' : "";
    const del = s.role === "owner" ? '<button class="btn danger" data-delete="' + esc(s.slug) + '" data-name="' + esc(s.name) + '">' + htm("console.list.delete") + '</button>' : "";
    const note = suspended ? '<p class="errtext">' + htm("console.list.suspended") + '</p>' : "";
    return '<article class="card"><div class="row"><h2>' + esc(s.name) + '</h2>' + (suspended ? '<span class="pill failed">' + htm("console.status.suspended") + '</span>' : status(s.status)) + '</div>' + note +
      '<p class="muted"><code>' + esc(s.slug) + '</code> \u00b7 ' + known("console.role.", s.role) + (s.theme ? ' \u00b7 ' + esc(s.theme) : '') + '</p>' + err + noUrl +
      '<div class="actions">' + open + appearance + retry + del + '</div></article>';
  };

  let timer = null;
  const loadList = async () => {
    const r = await getJson("/api/multisite/me");
    if (r.status === 401) return toLogin();
    if (!r.ok) { root.innerHTML = '<div class="err">' + htm("console.list.loadFailed") + '</div>'; return; }
    const me = r.body;
    renderNav(me);
    const atLimit = me.max != null && me.owned >= me.max;
    const banner = !me.emailVerified
      ? '<div class="note">' + htm("console.list.verifyEmail") + '</div>' : "";
    const create = atLimit
      ? '<p class="muted">' + esc(txtn("console.list.atLimit", me.max, { owned: me.owned, max: me.max })) + '</p>'
      : '<a class="btn primary" href="/sites/new"' + (me.emailVerified ? "" : ' aria-disabled="true" tabindex="-1"') + '>' + htm("console.list.create") + '</a>';
    root.innerHTML = banner +
      '<div class="row head"><h1>' + htm("console.list.title") + '</h1><div>' + create + '</div></div>' +
      (me.sites.length
        ? '<div class="grid">' + me.sites.map((s) => siteCard(s, me.staff, me.themed)).join("") + '</div>'
        : '<div class="empty"><p>' + htm("console.list.empty") + '</p></div>');
    root.querySelectorAll("[data-retry]").forEach((b) => b.addEventListener("click", async () => {
      b.disabled = true; b.textContent = txt("console.list.retrying");
      await getJson("/api/multisite/sites/" + b.dataset.retry + "/retry", { method: "POST", headers: { "x-emdash-request": "1" } });
      loadList();
    }));
    root.querySelectorAll("[data-delete]").forEach((b) => b.addEventListener("click", async () => {
      if (!confirm(txt("console.list.deleteConfirm", { name: b.dataset.name }))) return;
      b.disabled = true;
      const res = await getJson("/api/multisite/sites/" + b.dataset.delete + "/state", {
        method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1" }, body: JSON.stringify({ action: "delete" }),
      });
      if (!res.ok) { alert((res.body && (res.body.message || res.body.code)) || txt("console.list.deleteFailed")); b.disabled = false; return; }
      loadList();
    }));
    clearTimeout(timer);
    if (me.sites.some((s) => s.status === "provisioning")) timer = setTimeout(loadList, 4000);
  };

  // ---------- Create wizard ----------
  const slugify = (v) => v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  const loadWizard = async () => {
    const r = await getJson("/api/multisite/me");
    if (r.status === 401) return toLogin();
    const me = r.body || {};
    renderNav(me);
    if (!me.emailVerified) {
      root.innerHTML = '<div class="note">' + htm("console.wizard.verifyEmail") + '</div><p><a href="/sites">' + htm("console.wizard.backToSites") + '</a></p>';
      return;
    }
    if (me.max != null && me.owned >= me.max) {
      root.innerHTML = '<div class="note">' + esc(txtn("console.list.atLimit", me.max, { owned: me.owned, max: me.max })) + '</div><p><a href="/sites">' + htm("console.wizard.backToSites") + '</a></p>';
      return;
    }
    const tr = await getJson("/api/multisite/themes");
    const themes = (tr.body && tr.body.themes) || [];
    const picker = themes.length > 1
      ? '<fieldset class="themes"><legend>' + htm("console.wizard.theme") + '</legend>' + themes.map((t) =>
          '<label class="theme"><input type="radio" name="theme" value="' + esc(t.id) + '"' + (t.id === tr.body.default ? " checked" : "") + '>' +
          '<span><strong>' + esc(t.name) + '</strong><small>' + esc(t.description) + '</small>' +
          (/^https:\/\//.test(t.demoUrl || "") ? '<small><a href="' + esc(t.demoUrl) + '" target="_blank" rel="noopener">' + htm("console.wizard.preview") + '</a></small>' : '') + '</span></label>').join("") + '</fieldset>'
      : "";
    root.innerHTML =
      '<h1>' + htm("console.wizard.title") + '</h1>' +
      '<form id="f" novalidate>' +
      '<label for="name">' + htm("console.wizard.name") + '</label>' +
      '<input id="name" name="name" autocomplete="off" maxlength="80" required>' +
      '<label for="slug">' + htm("console.wizard.address") + '</label>' +
      '<div class="addr"><input id="slug" name="slug" autocomplete="off" maxlength="40" required aria-describedby="slugmsg">' +
      '<span class="muted" id="suffix"></span></div>' +
      '<p id="slugmsg" class="muted" aria-live="polite"></p>' + picker +
      '<p id="formerr" class="errtext" role="alert"></p>' +
      '<button class="btn primary" id="go" type="submit" disabled>' + htm("console.wizard.submit") + '</button> ' +
      '<a class="btn" href="/sites">' + htm("console.wizard.cancel") + '</a>' +
      '</form>';
    const name = document.getElementById("name"), slug = document.getElementById("slug");
    const msg = document.getElementById("slugmsg"), go = document.getElementById("go"), ferr = document.getElementById("formerr");
    let touched = false, ok = false, seq = 0, t = null;
    const check = () => {
      ok = false; go.disabled = true;
      clearTimeout(t);
      if (!slug.value) { msg.textContent = ""; return; }
      msg.textContent = txt("console.wizard.checking");
      t = setTimeout(async () => {
        const mine = ++seq;
        const c = await getJson("/api/multisite/slug-check?slug=" + encodeURIComponent(slug.value));
        if (mine !== seq) return;
        ok = !!(c.body && c.body.available);
        msg.className = ok ? "okmsg" : "errtext";
        msg.textContent = ok ? txt("console.wizard.available") : ((c.body && c.body.message) || txt("console.wizard.unavailable"));
        go.disabled = !(ok && name.value.trim());
      }, 300);
    };
    name.addEventListener("input", () => { if (!touched) slug.value = slugify(name.value); check(); go.disabled = true; });
    slug.addEventListener("input", () => { touched = true; check(); });
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!ok) return;
      go.disabled = true; ferr.textContent = "";
      const res = await getJson("/api/auth/organization/create", {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(Object.assign({ name: name.value.trim(), slug: slug.value },
          themes.length > 1 ? { metadata: { theme: (document.querySelector('input[name="theme"]:checked') || {}).value } } : {})),
      });
      if (!res.ok) {
        ferr.textContent = (res.body && (res.body.message || res.body.code)) || txt("console.wizard.createFailed", { status: res.status });
        go.disabled = false; return;
      }
      progress(slug.value, name.value.trim());
    });
  };

  const progress = (slug, name) => {
    root.innerHTML = '<h1>' + htm("console.progress.title", { name: esc(name) }) + '</h1>' +
      '<p class="muted" role="status" aria-live="polite" id="ps">' + htm("console.progress.duration") + '</p>';
    const ps = document.getElementById("ps");
    let tries = 0;
    const tick = async () => {
      tries++;
      const r = await getJson("/api/multisite/sites/" + slug);
      const st = r.body && r.body.status;
      if (st === "ready") {
        const me = (await getJson("/api/multisite/me")).body || { sites: [] };
        const s = me.sites.find((x) => x.slug === slug);
        root.innerHTML = '<h1>' + htm("console.progress.ready", { name: esc(name) }) + '</h1>' +
          '<div class="actions">' +
          (s && s.adminUrl ? '<a class="btn primary" href="' + esc(s.adminUrl) + '">' + htm("console.list.openAdmin") + '</a>' : '') +
          (s && s.url ? '<a class="btn" href="' + esc(s.url) + '">' + htm("console.list.openSite") + '</a>' : '') +
          '<a class="btn" href="/sites">' + htm("console.progress.mySites") + '</a></div>';
        return;
      }
      if (st === "failed") {
        root.innerHTML = '<h1>' + htm("console.progress.failed") + '</h1><p class="errtext">' + esc(r.body.error || "") + '</p>' +
          '<p><a class="btn primary" href="/sites">' + htm("console.progress.retry") + '</a></p>';
        return;
      }
      const step = r.body && r.body.step && MSG["console.progress.step." + r.body.step] != null ? "console.progress.step." + r.body.step : null;
      if (st === "provisioning" && step) ps.textContent = txt(step);
      if (tries > 90) { ps.textContent = txt("console.progress.slow"); return; }
      setTimeout(tick, 2500);
    };
    tick();
  };

  // ---------- Appearance (switch theme) ----------
  const loadAppearance = async () => {
    const slug = document.body.dataset.slug;
    const r = await getJson("/api/multisite/sites/" + slug + "/appearance");
    if (r.status === 401) return toLogin();
    const me = (await getJson("/api/multisite/me")).body || {};
    renderNav(me);
    if (!r.ok) { root.innerHTML = '<div class="err">' + htm("console.appearance.forbidden") + '</div><p><a href="/sites">' + htm("console.wizard.backToSites") + '</a></p>'; return; }
    const a = r.body;
    const list = (xs) => xs.map((x) => '<code>' + esc(x) + '</code>').join(", ");
    root.innerHTML =
      '<h1>' + htm("console.appearance.title", { name: esc(a.name) }) + '</h1>' +
      '<p class="muted">' + htm("console.appearance.intro") + '</p>' +
      '<form id="f"><fieldset class="themes"><legend>' + htm("console.wizard.theme") + '</legend>' + a.themes.map((t) =>
        '<label class="theme"><input type="radio" name="theme" value="' + esc(t.id) + '"' + (t.current ? " checked" : "") + '>' +
        '<span><strong>' + (t.current ? htm("console.appearance.current", { name: esc(t.name) }) : esc(t.name)) + '</strong><small>' + esc(t.description) + '</small>' +
        (!t.current && t.adds.length ? '<small>' + htm("console.appearance.adds", { list: list(t.adds) }) + '</small>' : '') +
        (!t.current && t.hides.length ? '<small>' + htm("console.appearance.hides", { list: list(t.hides) }) + '</small>' : '') + '</span></label>').join("") + '</fieldset>' +
      '<label class="check"><input type="checkbox" id="sample"> ' + htm("console.appearance.sample") + '</label>' +
      '<p id="msg" class="muted" role="status" aria-live="polite"></p>' +
      '<button class="btn primary" id="go" type="submit" disabled>' + htm("console.appearance.submit") + '</button> <a class="btn" href="/sites">' + htm("console.appearance.back") + '</a></form>';
    const go = document.getElementById("go"), msg = document.getElementById("msg");
    const chosen = () => (document.querySelector('input[name="theme"]:checked') || {}).value;
    root.querySelectorAll('input[name="theme"]').forEach((i) => i.addEventListener("change", () => { go.disabled = chosen() === a.current; }));
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const to = chosen();
      if (!to || to === a.current) return;
      go.disabled = true; msg.className = "muted"; msg.textContent = txt("console.appearance.switching");
      const res = await getJson("/api/multisite/sites/" + slug + "/theme", {
        method: "POST", headers: { "content-type": "application/json", "x-emdash-request": "1" },
        body: JSON.stringify({ theme: to, includeContent: document.getElementById("sample").checked }),
      });
      if (!res.ok) { msg.className = "errtext"; msg.textContent = (res.body && (res.body.message || res.body.code)) || txt("console.appearance.failed"); go.disabled = false; return; }
      let tries = 0;
      const poll = async () => {
        tries++;
        const p = await getJson("/api/multisite/sites/" + slug + "/appearance");
        if (p.ok && p.body.current === to) { loadAppearance(); return; }
        if (tries > 40) { msg.className = "errtext"; msg.textContent = txt("console.appearance.slow"); return; }
        setTimeout(poll, 2000);
      };
      poll();
    });
  };

  (mode === "new" ? loadWizard : mode === "appearance" ? loadAppearance : loadList)();
})();
`;

const STYLE = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: light-dark(#f6f7f9, #0b0c0e); color: light-dark(#111, #e8e8e8); }
  a { color: inherit; }
  header { padding: 14px 24px; border-bottom: 1px solid light-dark(#e5e7eb, #1f2124);
    display: flex; align-items: center; gap: 24px; flex-wrap: wrap; }
  header strong { font-size: 16px; }
  nav { display: flex; gap: 16px; flex-wrap: wrap; }
  nav a { text-decoration: none; color: light-dark(#4b5563, #9aa0a6); padding: 4px 0; border-bottom: 2px solid transparent; }
  nav a:hover, nav a[aria-current="page"] { color: inherit; border-bottom-color: currentColor; }
  main { padding: 24px; max-width: 920px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 16px; }
  h2 { font-size: 16px; margin: 0; }
  .head { margin-bottom: 16px; } .head h1 { margin: 0; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
  .muted { color: light-dark(#6b7280, #9aa0a6); font-size: 13px; margin: 4px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .card { background: light-dark(#fff, #141618); border: 1px solid light-dark(#e5e7eb, #1f2124); border-radius: 12px; padding: 16px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .btn { display: inline-block; font: inherit; font-weight: 600; font-size: 14px; cursor: pointer; text-decoration: none;
    padding: 8px 14px; border-radius: 8px; border: 1px solid light-dark(#d1d5db, #2b2f33);
    background: light-dark(#fff, #1a1c1f); color: inherit; }
  .btn.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .btn.danger { color: #dc2626; border-color: #dc262666; }
  .btn:focus-visible, input:focus-visible, a:focus-visible { outline: 2px solid #2563eb; outline-offset: 2px; }
  .btn[disabled], .btn[aria-disabled="true"] { opacity: .5; cursor: not-allowed; pointer-events: none; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .ready { background: #10b98122; color: #059669; }
  .provisioning { background: #f59e0b22; color: #b45309; }
  .failed { background: #ef444422; color: #dc2626; }
  .unknown { background: #6b728022; color: #6b7280; }
  .note { padding: 12px 16px; border: 1px solid #f59e0b; border-radius: 10px; background: #f59e0b14; margin-bottom: 16px; }
  .err { padding: 16px; border: 1px solid #ef4444; border-radius: 10px; color: #dc2626; background: #ef444411; }
  .errtext { color: #dc2626; font-size: 13px; margin: 4px 0; }
  .okmsg { color: #059669; font-size: 13px; margin: 4px 0; }
  .empty { padding: 32px; text-align: center; border: 1px dashed light-dark(#d1d5db, #2b2f33); border-radius: 12px; }
  form { max-width: 460px; }
  label { display: block; font-weight: 600; margin: 16px 0 6px; }
  input { width: 100%; font: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid light-dark(#d1d5db, #2b2f33);
    background: light-dark(#fff, #141618); color: inherit; }
  .addr { display: flex; align-items: center; gap: 8px; } .addr input { flex: 1; }
  form .btn { margin-top: 16px; }
  label.check { display: flex; align-items: center; gap: 8px; font-weight: 400; margin: 16px 0 0; }
  label.check input { width: auto; }
  fieldset.themes { border: 0; padding: 0; margin: 16px 0 0; display: grid; gap: 8px; }
  fieldset.themes legend { font-weight: 600; margin-bottom: 6px; padding: 0; }
  label.theme { display: flex; align-items: flex-start; gap: 10px; margin: 0; font-weight: 400; padding: 10px 12px;
    border: 1px solid light-dark(#d1d5db, #2b2f33); border-radius: 10px; background: light-dark(#fff, #141618); cursor: pointer; }
  label.theme:has(input:checked) { border-color: #2563eb; box-shadow: 0 0 0 1px #2563eb; }
  label.theme input { width: auto; margin-top: 4px; }
  label.theme small { display: block; color: light-dark(#6b7280, #9aa0a6); }
`;

/** The client script's messages, as JSON safe inside a <script> element. */
const clientMessages = (): string => JSON.stringify(messagesFor("console.")).replace(/</g, "\\u003c");

export function consolePageHtml(mode: "list" | "new" | "appearance", slug = ""): string {
	return `<!doctype html>
<html lang="${getLocale()}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${tHtml(mode === "new" ? "console.page.title.new" : mode === "appearance" ? "console.page.title.appearance" : "console.page.title.list")}</title>
<style>${STYLE}</style>
</head>
<body data-mode="${mode}" data-slug="${slug.replace(/[^a-z0-9-]/g, "")}">
<header><strong>${tHtml("console.page.brand")}</strong><nav id="nav" aria-label="${tHtml("console.page.navLabel")}"></nav></header>
<main><div id="root"><p class="muted">${tHtml("console.page.loading")}</p></div></main>
<script type="application/json" id="multisite-i18n">${clientMessages()}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
