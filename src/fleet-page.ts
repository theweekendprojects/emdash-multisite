/**
 * The fleet dashboard HTML, served by the middleware at /admin/fleet on the
 * control-plane host (staff-gated — the gate lives in the middleware; this is
 * just the shell). It fetches /api/multisite/fleet (also staff-gated) and
 * renders a table.
 *
 * ponytail: plain HTML + a little vanilla JS, not a HeroUI React island. A
 * read-only table of a handful of sites does not justify shipping/compiling a
 * React island through the host's build. Upgrade path: swap this for an
 * injected .astro page + island (same /api/multisite/fleet endpoint) if the
 * fleet UI grows.
 */

const CLIENT_JS = String.raw`
(async () => {
  const root = document.getElementById("root");
  const countEl = document.getElementById("count");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  const pill = (s) => '<span class="pill ' + esc(s) + '">' + esc(s) + '</span>';
  const date = (d) => d ? new Date(d).toISOString().slice(0, 10) : "\u2014";
  try {
    const res = await fetch("/api/multisite/fleet", { headers: { accept: "application/json" } });
    if (res.status === 403) { root.innerHTML = '<div class="err">Forbidden \u2014 staff only. Sign in as a control-plane admin.</div>'; return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const { sites } = await res.json();
    countEl.textContent = sites.length + " site" + (sites.length === 1 ? "" : "s");
    root.innerHTML =
      '<table><thead><tr><th>Site</th><th>Name</th><th>Owner</th><th>Status</th><th>Users</th><th>Created</th></tr></thead><tbody>' +
      sites.map((s) =>
        '<tr><td><code>' + esc(s.slug) + '</code></td><td>' + esc(s.name) + '</td>' +
        '<td>' + esc(s.ownerEmail || "\u2014") + '</td><td>' + pill(s.status) + '</td>' +
        '<td>' + esc(s.userCount) + '</td><td class="muted">' + esc(date(s.createdAt)) + '</td></tr>'
      ).join("") +
      '</tbody></table>';
  } catch (e) {
    root.innerHTML = '<div class="err">Could not load the fleet: ' + esc(String((e && e.message) || e)) + '</div>';
  }
})();
`;

const STYLE = String.raw`
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: light-dark(#f6f7f9, #0b0c0e); color: light-dark(#111, #e8e8e8); }
  header { padding: 20px 24px; border-bottom: 1px solid light-dark(#e5e7eb, #1f2124);
    display: flex; align-items: baseline; gap: 12px; }
  h1 { font-size: 18px; margin: 0; }
  .muted { color: light-dark(#6b7280, #9aa0a6); font-size: 13px; }
  main { padding: 24px; max-width: 1000px; }
  table { width: 100%; border-collapse: collapse; background: light-dark(#fff, #141618);
    border: 1px solid light-dark(#e5e7eb, #1f2124); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid light-dark(#eef0f2, #1b1d20); }
  th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: light-dark(#6b7280, #9aa0a6); }
  tr:last-child td { border-bottom: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .ready { background: #10b98122; color: #059669; }
  .provisioning { background: #f59e0b22; color: #d97706; }
  .failed { background: #ef444422; color: #dc2626; }
  .unknown { background: #6b728022; color: #6b7280; }
  .err { padding: 16px; border: 1px solid #ef4444; border-radius: 10px; color: #dc2626; background: #ef444411; }
`;

export function fleetPageHtml(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fleet — sites</title>
<style>${STYLE}</style>
</head>
<body>
<header><h1>Fleet</h1><span class="muted" id="count"></span></header>
<main><div id="root"><p class="muted">Loading…</p></div></main>
<script>${CLIENT_JS}</script>
</body>
</html>`;
}
