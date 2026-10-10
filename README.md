# emdash-multisite

**PRIVATE.** Run many EmDash sites from one codebase, one Cloudflare Worker, and one D1 database —
no Workers for Platforms, no fork of EmDash core. Each site gets its own prefixed tables
(`ec_posts$acme`); EmDash's in-memory caches are made per-site by a build-time patch; creating a
Better Auth **organization** provisions a site and its **slug** becomes the subdomain.

> Do not publish to the public npm registry. See [Installing](#installing-private) for private
> options. Background and full history: `emdash-plan/product/single-db-multisite.md`.

---

## Table of contents
- [How it works (30 seconds)](#how-it-works-30-seconds)
- [Requirements](#requirements)
- [Installing (private)](#installing-private)
- [Set up a site (the 3 wires)](#set-up-a-site-the-3-wires)
- [Config reference](#config-reference)
- [The control-plane site vs tenant sites](#the-control-plane-site-vs-tenant-sites)
- [Routing / subdomains](#routing--subdomains)
- [Provisioning a site](#provisioning-a-site)
- [The customer console](#the-customer-console)
- [Themes](#themes)
- [Creating sites, limits and recovery](#creating-sites-limits-and-recovery)
- [Local development](#local-development)
- [Deploy to Cloudflare](#deploy-to-cloudflare)
- [Tests / self-checks](#tests--self-checks)
- [Upgrading EmDash (important)](#upgrading-emdash-important)
- [Operating a fleet](#operating-a-fleet)
- [Limits & gotchas](#limits--gotchas)
- [FAQ](#faq)
- [Package exports](#package-exports)

---

## How it works (30 seconds)

Three mechanisms, three wires in `astro.config.mjs`:

1. **Table prefix** — a wrapped Kysely dialect rewrites SQL so site `acme` reads/writes
   `ec_posts$acme`, `users$acme`, … The **primary** site keeps unprefixed names, so an existing
   single-site install is unchanged. `users` is per-site, so roles are per-site with no RBAC change.
2. **Per-site caches** — a Vite plugin rewrites EmDash's process-wide caches (settings, collections,
   taxonomies, runtime, secrets, …) so each site gets its own copy in the Worker isolate. Without
   this, one site's cached settings leak into another. The build **fails loudly** if EmDash core
   changes a cache it doesn't recognize.
3. **Outer middleware** — resolves the site from the request hostname before EmDash reads anything,
   and (on the control-plane site) turns "create an organization" into "create a site".

It is **not an EmDash plugin**: a plugin can't replace the database or patch the build. It plugs
into slots EmDash already exposes (`database:`, `vite.plugins`, `middleware.outer`).

## Requirements

- **EmDash ≥ 0.30** on **Cloudflare Workers** (D1 + R2). SQLite/Node works for local dev only.
- **Node ≥ 22.18** for tooling (the self-checks use native TS execution). On Cloudflare the Worker
  runs the compiled bundle; Node version there is irrelevant.
- Peer deps (provided by the consuming site): `emdash`, `@emdash-cms/cloudflare`, `kysely`.
- For the org→site flow: `emdash-better-auth` with the **organization** feature enabled.
- `pnpm` (the EmDash templates use it).

## Installing (private)

Never `npm publish` to the public registry. Pick one:

- **Git dependency** (separate site repos):
  ```jsonc
  // package.json
  "emdash-multisite": "github:theweekendprojects/emdash-multisite#<tag-or-commit>"
  ```
  Pin a tag/commit so sites don't drift. The build machine needs read access to the private repo.

- **pnpm workspace** (sites + this package in one repo): add both to `pnpm-workspace.yaml`, then
  `"emdash-multisite": "workspace:*"`. Best for a monorepo fleet; no version juggling.

- **GitHub Packages** (private, versioned, feels like npm): publish under
  `@theweekendprojects/emdash-multisite` with an `.npmrc` scope line pointing at GitHub.

- **Local `file:`** (dev only, folders side by side): `"emdash-multisite": "file:../emdash-multisite"`.

This package ships **TypeScript source** (like `emdash-better-auth`); the consuming site's build
compiles it. There is no `dist`.

## Set up a site (the 3 wires)

```js
// astro.config.mjs
import cloudflare from "@astrojs/cloudflare";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { withSites } from "emdash-multisite";          // wire 1
import { multisiteCaches } from "emdash-multisite/vite"; // wire 3
import emdash from "emdash/astro";
import { defineConfig } from "astro/config";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  vite: {
    plugins: [multisiteCaches()],                       // wire 3: per-site cache patch (build-time)
  },
  integrations: [
    emdash({
      database: withSites(                              // wire 1: per-site tables
        d1({ binding: "DB" }),
        { primary: "main", wildcard: "sites.example.com" },
      ),
      storage: { ...r2({ binding: "MEDIA" }), entrypoint: "emdash-multisite/storage" }, // one bucket, key prefix per site
      middleware: { outer: "emdash-multisite/middleware" }, // wire 2: hostname -> site + org glue
      // ...authProviders / plugins (e.g. emdash-better-auth) ...
    }),
  ],
});
```

That's the whole integration: install + three wires. No plugin entry, no EmDash core change.

> A single `emdashMultisite()` integration that collapses the three wires into one array entry is
> on the roadmap (see `emdash-plan`), but the three wires above are the stable surface today.

## Config reference

`withSites(innerDatabaseDescriptor, sites)` — `sites` is a `SitesConfig`:

| Field | Type | Meaning |
|---|---|---|
| `primary` | `string` (required) | The site that keeps **unprefixed** tables. Use for the control plane / your existing single site. |
| `wildcard` | `string` | Base domain. `acme.<wildcard>` → site `acme`. |
| `hosts` | `Record<hostname, siteId>` | Exact hostname → site id, for custom domains and for hosts with no wildcard (e.g. `*.workers.dev`). |
| `accountTab` | `boolean` | Show "My sites" as the **Sites** tab of Better Auth UI's account page (`/account/sites`); `/sites` redirects there and sign-in lands there. Needs the `auth-ui` plugin above. |
| `deleteGraceDays` | `number` | Days a deleted site stays restorable before it is purged. Default 14. |
| `postLoginPath` | `string` | Where users land after signing in or up on the control plane. Default `/sites`. The middleware adds `?redirect=` to `/login`, `/signup`, `/auth/sign-in`, `/auth/sign-up` when none is given, and sends already-signed-in visitors of those pages there. No change to `emdash-better-auth` needed. |
| `limits` | `{ sitesPerUser?, totalSites? }` | Caps on site creation. Default `{ sitesPerUser: 3 }`; pass `{}` for no caps. See [Creating sites](#creating-sites-limits-and-recovery). |

| `themes` | `Record<id, { name, description?, seed? }>` | Themes a new site can pick. Each `seed` is an EmDash seed JSON applied when the site is created. Omit for a single theme (the host's bundled seed). |
| `defaultTheme` | `string` | Preselected in the wizard and used when none is requested. Defaults to the first theme. |

Supported inner adapters: `d1({...})` (Cloudflare) and `sqlite({...})` (local/Node dev). Site ids
are DNS labels: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`. Unknown hostnames resolve to `primary`.

## The control-plane site vs tenant sites

- **Control-plane site = the `primary` site.** This is where people sign up and create
  organizations. It runs the org→site glue (slug guard, provisioning, status endpoint). Lock its
  EmDash admin to your staff.
- **Tenant sites** are every other site. Each has its own `users`, content, settings, and its owner
  is a real EmDash **admin (role 50)** of that site only — not of any other site.
- One Better Auth identity on the control plane does **not** grant CMS access elsewhere; each tenant
  site has its own `users` row for that person (created at provision time).

## Routing / subdomains

The middleware maps the request `Host` to a site: exact `hosts` first, then `wildcard`, else
`primary`.

- **Wildcard subdomains** (`acme.sites.example.com`): set up once — a `*.sites.example.com` DNS
  record + a Worker route. After that every new tenant subdomain needs **no** DNS/route/redeploy.
- **`*.workers.dev` has no wildcard.** For preview deploys, map each hostname explicitly in `hosts`
  (and `wrangler versions upload --preview-alias <name>`).
- **Custom domains** (`blog.acme.com`): add to `hosts`, then Cloudflare for SaaS Custom Hostnames
  (not built here; a later step).

## Provisioning a site

Two ways:

- **Automatic (org→site):** on the control-plane site, a successful
  `POST /api/auth/organization/create` provisions a site named after the org **slug** in the
  background. Poll `GET /api/multisite/sites/<slug>` → `{ status: "provisioning" | "ready" |
  "failed" }`. The org owner becomes admin of the new site and can sign in there with the same
  credentials.
- **Manual (script/CLI):** `provisionSite(db, siteId)` runs EmDash's migrations as that site. `db`
  must be a Kysely built on the wrapped dialect (see `scripts/provision.ts` in the smoke-test site).

Provisioning is **idempotent** — re-running finishes a half-built site. It creates ~227 schema
objects per site (one full EmDash schema).

## First admin & the setup wizard

EmDash ships a first-run **setup wizard** (`/_emdash/admin/setup`) that creates the first admin via
passkey. In a multi-site fleet, sites are born **without** the wizard, so you must make sure it
never runs — otherwise it appears and then refuses with "admin user already exists" (because a user
already exists but `emdash:setup_complete` was never set).

- **Tenant sites: automatic.** Provisioning creates the owner as admin and sets
  `emdash:setup_complete = true`. The wizard never shows. Nothing to do.
- **Control-plane (`primary`) site: one-time bootstrap.** Its first human signs up through Better
  Auth as a *subscriber* (role 10), not through the wizard. Promote your staff account to admin and
  mark setup complete, once:

  ```ts
  // scripts/bootstrap.ts  — run once after you sign up on the control-plane site
  import { Kysely } from "kysely";
  import { createDialect } from "emdash-multisite/db/d1"; // or /db/sqlite in local dev
  import { bootstrapControlPlane } from "emdash-multisite/bootstrap";

  const db = new Kysely<never>({
    dialect: createDialect({ inner: { binding: "DB" }, sites: { primary: "main", wildcard: "sites.example.com" } }),
  });
  await bootstrapControlPlane(db, "you@example.com"); // promotes to role 50 + sets setup_complete
  await db.destroy();
  ```

  (On a deployed Worker you can equivalently run two `wrangler d1 execute` statements: `UPDATE users
  SET role=50, email_verified=1 WHERE email=…` and set `emdash:setup_complete` to `true`.)

Order on the control plane: deploy → sign up your staff account → run bootstrap → sign in at
`/_emdash/admin`.

## Local development

`workerd` needs macOS 13.5+. If you can run it, use the Cloudflare adapter and `wrangler dev`.
If you can't (older macOS), develop against the **Node adapter + SQLite**:

```js
database: withSites(sqlite({ url: "file:./data.db" }), { primary: "main", wildcard: "localhost" }),
```

Chrome/Firefox resolve `*.localhost` to your machine, so `acme.localhost:4321` hits site `acme`.
Node-adapter dev needs a few shims that are **not** part of this package and are **not** needed on
Cloudflare — a `cloudflare:workers` alias, `ssr.noExternal` for the HeroUI/Better-Auth-UI packages,
and an `optimizeDeps` entry. See the smoke-test site for a working example. Run tooling with Node
≥ 22.18.

## Deploy to Cloudflare

1. `wrangler d1 create <db>`, put its `database_id` in `wrangler.jsonc` (`binding: "DB"`), add an
   `r2_buckets` entry (`binding: "MEDIA"`).
2. Set secrets your auth needs (e.g. `wrangler secret put BETTER_AUTH_SECRET`).
3. `astro build && wrangler deploy`.
4. The **first request** to a fresh site runs its migrations (cold ~a few seconds). The control
   plane (`primary`) is just the unprefixed site.

Nothing in this package creates Cloudflare resources for you — provisioning only writes tables into
the existing D1. Adding a brand-new Worker/DB per fleet is your deploy, not per-tenant.

## Tests / self-checks

Run with Node ≥ 22.18 (e.g. `~/.nvm/versions/node/v22.23.2/bin/node --no-warnings <script>`):

- `scripts/selfcheck.ts` — runs EmDash's **real migrations** and repositories through the wrapper
  for several sites; asserts each site's schema equals the primary's modulo the `$site` suffix, FKs
  stay in-site, triggers fire on their own tables, and content is isolated. Needs `emdash` installed
  (run it from a consuming site, or point it at one).
- `scripts/caches.selfcheck.ts <path-to-node_modules>` — the **cache tripwire**: scans `emdash` +
  all `@emdash-cms/*` and fails if any EmDash cache key is unclassified or a patched declaration
  changed shape. **Run this on every EmDash upgrade.**
- `scripts/orgs.selfcheck.ts` — slug validation, org-response parsing, creation limits, reconcile
  rules, theme resolution and theme routing paths (no deps; pure rules in `src/rules.ts`).
- `scripts/console.selfcheck.ts` — parses the console pages' embedded client script (a syntax slip
  only shows in the browser otherwise) and checks site URL rules.
- `scripts/fleet.selfcheck.ts` — fleet view rules.

## Upgrading EmDash (important)

The cache patch rewrites **EmDash's own code** at build time, so an EmDash upgrade can move it.
Safe routine:

1. Bump `emdash` (+ `@emdash-cms/*`) in a **staging** build.
2. Run `scripts/caches.selfcheck.ts` against the new `node_modules`, and `scripts/selfcheck.ts`.
3. If the build or tripwire fails, it tells you which cache changed — update `HOLDER_KEYS` /
   `SLOT_KEYS` / `SITE_INDEPENDENT_KEYS` in `src/vite.ts`, re-run.
4. Only then deploy. **Never auto-upgrade EmDash in production without a build.**

The tripwire failing is the feature: it refuses to ship a cache that would leak across sites.

## The customer console
Two pages on the control-plane host, plain HTML served by the middleware (no host build step):

| Page | What it does |
|---|---|
| `/sites` | The signed-in user's sites (any org they belong to) with status, Open site, Open admin, Retry. Shows the cap ("9 of 3 sites") and an unverified-email notice. Polls while a site is being set up. |
| `/sites/new` | Wizard: name, address (auto-filled from the name, live availability check), Create, then a progress screen until the site is ready. |

Anonymous visitors are sent to `/login?redirect=<page>`. Both pages use `GET /api/multisite/me`
(sites, role, status, URL, cap, staff flag) and `GET /api/multisite/slug-check?slug=`, and create
through Better Auth's `organization/create`, so the checks below apply to them too. A site's
public URL comes from `hosts` (exact entry) or `wildcard`; with neither configured the card says
no public address is set up.

## Themes
A theme is a seed (collections, settings, starter content) plus the page layouts that render it.
The seeds are configured here; the layouts ship in the host codebase (one Worker, one build).

```js
const seed = (id) => JSON.parse(readFileSync(new URL(`./themes/${id}.seed.json`, import.meta.url), "utf8"));
withSites(d1({ binding: "DB" }), {
  primary: "main",
  wildcard: "example.com",
  themes: {
    marketing: { name: "Marketing", description: "Landing page, pricing, contact.", seed: seed("marketing") },
    blog: { name: "Blog", description: "Posts, categories, tags.", seed: seed("blog") },
  },
  defaultTheme: "marketing",
});
```

The theme id travels in the organization `metadata` (`{ "theme": "blog" }`) on
`organization/create`; an unknown id is rejected with `400 INVALID_THEME`, a missing one gets the
default. The wizard shows a picker when there is more than one theme. Provisioning applies that
theme's seed and records it in the site's `multisite:theme` option, which the host reads to choose
layouts. Retries re-read the theme from the org, so a recovered site keeps its theme.

### How a site gets its theme's pages
A theme's pages are a route subtree in the host: `src/pages/theme-routes/<id>/` (its layouts,
components and styles live in `src/themes/<id>/`). The middleware rewrites every public `GET`/`HEAD`
request to the subtree of the site's theme, so `/` on a blog site renders
`theme-routes/blog/index.astro` while the same `/` on a portfolio site renders
`theme-routes/portfolio/index.astro`. Consequences:

- Themes never collide on a URL, and a theme's CSS loads only on its own pages (the stock templates
  all define the same `:root` design tokens, so bundling them into one page would clash).
- A URL the theme does not have (`/pricing` on a blog) falls to the theme's own 404 page.
- Platform paths are never themed: `/_emdash`, `/_astro`, `/_image`, `/api`, `/auth`, `/login`,
  `/signup`, `/account`, `/organization`, `/admin`, `/audit-log`, `/sites`, `/.well-known`,
  `/sitemap*.xml`, `/robots.txt`, `/llms.txt`.
- Requests to `/theme-routes/...` directly get a 404, so one theme's pages cannot be shown on
  another site's host.
- The theme id is read from the site's `multisite:theme` option and memoised for a minute per
  isolate (it runs on every public request and only changes at provisioning).
- Astro's `Astro.url` reflects the rewritten path inside a theme page. Use `Astro.originPathname`
  for the public path (canonical links, "current page" in nav). Stock templates need three small
  patches for this; see the host's `scripts/import-themes.mjs`.

### Switching a live site's theme
Owners (and staff) switch from `/sites` -> **Appearance** (`/sites/<slug>/appearance`), or via
`POST /api/multisite/sites/<slug>/theme` with `{ "theme": "blog", "includeContent": true }` and the
`X-EmDash-Request: 1` header. Switching is additive and never deletes: the target theme's seed is
applied with skip-on-conflict (missing collections, menus and settings are created; existing ones,
content and the site title are untouched), then the site's `multisite:theme` option flips. Anything
the new theme does not show stays in the database and returns if the owner switches back. The page
shows per theme what it adds and hides. Re-applying the current theme is allowed and repairs a site
that lacks the theme's collections. The change shows within about a minute (the theme is memoised
per isolate). Installing a brand-new theme still needs a build and deploy: Astro compiles pages at
build time.

Themes should not share a collection slug with a different shape. The stock marketing theme uses
`landing_pages` (its `content` is a blocks field) while blog, portfolio and starter share
`pages` (portable text).

With no `themes` configured nothing is rewritten and the host's own pages serve every site.

Seeds are applied with `skipMediaDownload` (downloading images would also eat the provisioning time
budget), so seed images are skipped.

## Logs
Notable events are written as one JSON line each (`src/log.ts`): `site.ready` (site, theme, whether it was cloned, total
ms, per-step timings), `site.failed`, `template.built`, `backup.saved`, `backup.restored`, `site.purged`,
`signup.blocked_domain`, `signup.rate_limited`, `create.rate_limited`, `create.race_lost`, `password.synced`. Turn on
Workers Logs with `"observability": { "enabled": true }` in `wrangler.jsonc` to search and count them in the dashboard
(`wrangler tail` shows them live). No secrets, passwords or full email addresses are logged.

## Free tier (recommended settings)
Anyone can register on the control plane and create a site; the limits decide what free means. For one free site per person:
```ts
withSites(d1({ binding: "DB" }), {
  primary: "main", wildcard: "example.com", appUrl: "https://app.example.com", authBar: true,
  limits: { sitesPerUser: 1, totalSites: 5000, mediaBytesPerSite: 200 * 1024 * 1024 },
})
```
The account page shows "N of M sites used". Needed alongside: a working email sender with `requireEmailVerification` on (otherwise
nobody can create a site), the rate limit bindings, and Turnstile on sign-up (see Abuse controls). Paid plans raise these numbers
per user (not built: plans, OP-11). Not built either: reclaiming idle free sites.

## Sign in / Sign up links in the theme header
`authLinks: true` sets `Astro.locals.multisite = { signup, account }` for themed pages. The host's `AuthLinks.astro` component
(`multisite-smoke/src/multisite/`, patched into each theme's header by `import-themes.mjs`) prints plain links with the theme's
own font and colour, decided by `authLinksFor`: a visitor sees **Sign in** and **Sign up** while the site's public sign-up is on
(the control plane is always on), nothing while it is off; a signed-in person sees **My account** and, from the author role
(30) up, **Admin** (themes that draw their own Admin link pass `admin={false}`). It is rendered on the server: **no script,
no extra request, +0.2 KB of HTML** for a visitor. Pages differ only between "has a session" and "has none", which the
themes already did for their Admin link. Public theme demos get none. Measured against no links and against an earlier
script-driven bar in `emdash-plan/product/multisite-performance.md`. On a narrow screen the links wrap onto their own row
in the header (+32 to +48 px); folding them into a theme's mobile menu is a later polish.

## Unknown sites
Before a site's runtime starts, the middleware checks the site has tables (`siteExists`). A host for a site that was never
created, or was purged, answers 404 and creates nothing. Without this, wildcard DNS would let a request for any subdomain
create ~90 tables. The answer is remembered per isolate (15 s for a known site, 10 s for an unknown one). Check:
`multisite-smoke/scripts/unknown-site-check.mjs`.

## Public sign-up per site
Whether visitors can register is a setting of each site: "Allow new sign-ups" (`emdash-better-auth` 0.11.0, in the site's
admin under Settings, Better Auth). A new customer site is created with it **off**: only people the owner adds can sign in,
and any other attempt to create an account answers `403 SIGN_UP_DISABLED`. Owners who want subscribers turn it on. The
control plane keeps it on (anyone can register and create a site). The setting is not inherited from the control plane, and
a re-run of provisioning never changes it back. The Site page in each admin shows the current value. Sites created before
the setting existed have none stored, which means open; close them with the runbook's backfill. The switch covers every
way an account is created (email, social, magic link, one-time code), because it is a single user-creation hook.
Check: `multisite-smoke/scripts/signup-switch-check.mjs`.

## Fleet page (staff)
On the control plane the plugin's **Site** page in the EmDash admin (`/_emdash/admin/plugins/multisite/site`, also reached
from `/admin/fleet`) is the fleet: counts (sites, needing attention, suspended, deleted but not purged, users), and one row
per site with its owner, setup status, state, users, age and an **Actions** menu: suspend, resume, delete, restore, retry
setup, back up now. Purging a deleted site is a separate form that needs a confirmation toggle, because it cannot be
undone. The same rules as the HTTP routes apply (`transition`, purge only for a deleted site); slow work (purge, retry)
continues after the response. Only reachable with `plugins:manage`, which on the control plane means staff. The page is
built by `fleet-blocks.ts` (pure, self-checked) and the actions run in `fleet-actions.ts`. JSON for scripts:
`GET /api/multisite/fleet` (staff).

## Theme switching lives in the account page
Choosing another theme for a site is a view of the **Sites** tab (Better Auth UI): the site card's **Appearance** button
(or `/account/sites?appearance=<slug>`) shows every theme with what it adds and hides, a Preview link when a demo exists,
and a **Switch theme** button. The old standalone `/sites/<slug>/appearance` address redirects there (hosts without the account
tab keep the old page). The site's own admin Site page shows the current theme and a **Change theme** link to the same view;
it no longer carries a second picker.

## Public theme demos
A template site (`tpl-<theme>`) is a seeded copy of its theme, so it doubles as a public demo with no extra content:
give it an address like any site (a `hosts` entry, or `tpl-<theme>.<wildcard>` automatically) and visitors can browse it.
Demos are read-only: only GET/HEAD, the admin, auth, plugin and write APIs answer 404/405 (`demoGuard`); pages, search and
media files work. Each page gets a strip at the bottom, "This is a demo of the X theme. Use this theme", which opens the
create-site wizard with the theme preselected (`/account/sites?new=1&theme=blog`). The theme pickers show a **Preview**
link for every theme whose template is complete and has an address (`demoUrl` in `/api/multisite/themes`, memoised 60 s).
The strip is fixed to the bottom and the page gets bottom padding so it never covers the footer. It needs `HTMLRewriter` (Workers) and `appUrl`. A template needs `emdash:setup_complete` for its search API;
`buildTemplate` sets it. Check: `multisite-smoke/scripts/demo-check.mjs`.

## Using the package (private distribution)
The package is private and not on npm. A host installs it from this repository, pinned by tag:
`"emdash-multisite": "github:theweekendprojects/emdash-multisite#v0.4.0"` (install verified: npm fetches the tag and
the sources, which the host's Vite compiles). Releasing is `git tag vX.Y.Z && git push origin vX.Y.Z` after the CI is
green and `package.json` carries the same version. In CI the host needs read access to this repo: a fine-grained token
with read-only Contents access, wired in with a `git config url.<token>@github.com/.insteadOf` line.
`examples/host-deploy.yml` is a ready-to-copy deploy workflow (install, build, `wrangler deploy`). During development
the host can keep `"emdash-multisite": "file:../emdash-multisite"`.

## Backups and restore (per site)
D1 Time Travel restores the whole database, so one damaged site needs its own copy. A backup is one JSON file in the
media bucket at `_backups/<site>/<time>.json`: the site's `CREATE` statements plus its rows as multi-row `INSERT`s (values
written by SQLite's `quote()`, so blobs and NULLs survive). The cron backs up at most one ready site per tick that has
no backup from the last day, and keeps the newest 7 per site. Staff routes (CSRF header, run inside the request):
- `POST /api/multisite/sites/<slug>/backup` take one now.
- `GET  /api/multisite/sites/<slug>/backups` list keys, oldest first.
- `POST /api/multisite/sites/<slug>/restore {"key": "...", "replace": true}` rebuild the site from a backup. Without
  `replace` the site must have no tables (409). With it the current state is backed up first (`-pre-restore`), then the
  tables are dropped and rebuilt in one atomic D1 batch, so a bad restore can itself be undone.
Not included: the organization, state, theme and status records (they stay as they are), and the control plane (primary
site; use Time Travel). Warm isolates may serve cached site settings for a short while after a restore. Purging a site
deletes its backups too, so a deleted customer's data does not outlive the grace period. Needs the D1 and R2 bindings.

## Abuse controls
Sign-up is open, and every account can create sites (~90 D1 tables each), so there are four brakes:
- **Throwaway mail**: sign-up with a disposable-mail domain is refused (`EMAIL_DOMAIN_BLOCKED`, 400). A built-in
  list plus `blockedEmailDomains: ["bad.example"]` in the config. Subdomains match (`x.mailinator.com`).
- **Reserved names**: infrastructure, mail, "looks official" (`secure`, `webmail`, `billing`) and big-brand names
  cannot become sites (`RESERVED_SITE_IDS` in `rules.ts`; the `tpl-` prefix is reserved for templates).
- **Rate limits** (optional): declare Cloudflare Rate Limiting bindings `SIGNUP_LIMITER` (per client IP) and
  `CREATE_LIMITER` (per user) in `wrangler.jsonc`; exceeding them returns 429. Without the bindings nothing is limited.
  Counters are per Cloudflare location and periods are 10 or 60 s, so they stop bursts, not slow trickles.
- **Site limits hold under parallel requests**: the limit check runs before Better Auth creates the organization, so
  parallel requests all passed it. It now runs again after creation; a site ranked past `sitesPerUser` or `totalSites`
  (by creation time) is deleted unprovisioned (`lostLimitRace`).
Turnstile (needs a site key from the production domain) and alerting on `totalSites` are not built yet.

## Templates (fast site creation)
Migrating and seeding a new site takes ~70 s. With a **template** it takes ~4 s: staff build one template
site per theme once (`POST /api/multisite/templates {"theme":"blog"}`, ~30 s, runs inside the request), stored as
site `tpl-<theme>` (the `tpl-` prefix is reserved and hidden from the fleet). A new site then copies it in
one D1 batch: the template's `CREATE` statements with the suffix swapped, then `INSERT ... SELECT` per table, then
triggers; the owner, title and options are patched afterwards. The batch is atomic, so a failure leaves nothing.
Without a complete template (or on the Node/SQLite host) creation falls back to migrate-and-seed. After an
EmDash upgrade the template is stale until rebuilt (`{"theme":"blog","rebuild":true}` drops it and builds again); sites created from it still run any newer
migrations like any older site. D1 only. Script: `multisite-smoke/scripts/build-templates.mjs`.

## Media (uploads)
`emdash-multisite/storage` wraps the R2 storage: every key gets a `<site>/` prefix on write and read,
and listings only return the active site's keys. Keys in a site's `media` table stay unprefixed. The
wrapper reads the site on every call because core caches one storage instance per Worker. Purging a
site deletes its prefix. `limits.mediaBytesPerSite` caps a site (sum of `media.size`, checked before
each upload, so one file can overshoot). With a CDN `publicUrl` the URL carries the prefix.
Check it live: `multisite-smoke/scripts/media-check.mjs`.

## Opening a tenant's admin (handoff)
Cookies are per host, so a user signed in on the control plane is signed out on `acme.example.com`.
"Open admin" on `/sites` therefore goes to `/sites/<slug>/open-admin` on the control plane, which
checks the user may manage the site, signs a link (HMAC-SHA256, 60 s, bound to user and site, one
nonce) and redirects to `https://<site>/_multisite/handoff?t=...`. The tenant verifies the link,
accepts its nonce once, checks the user exists on that site, starts the user's session there and
redirects to `/_emdash/admin`. Replayed, tampered, expired or wrong-site links get `403`. The
signing key is created on first use and stored on the control plane (`multisite:handoff-secret`),
so no environment secret is shared. Anyone who can read the database can read that key and sign in as any site's
owner, so in production set a Worker secret instead: `wrangler secret put MULTISITE_SECRET` (32+ characters; it wins over
the stored key). Set it before the first handoff or users with a link in flight get a "Link expired" page. This signs the **owner** in; it does not sync passwords (a
password changed on the control plane reaches the owner's sites, see "Passwords").

## Passwords
The owner's credential account is copied into each site at creation. A password change or reset on the control plane
(`change-password`, `reset-password`, `set-password` returning 200) copies the changed account to every non-suspended site
that user owns, right after the response; the cron repeats it for the last 10 minutes as a safety net. Editors who signed up
on a site have their own account there and are not touched.

## Scheduled work (cron) for every site
EmDash's scheduled handler publishes due scheduled content and runs plugin cron for the one ambient
site, which in a cron trigger (no request, no hostname) is the primary. Wrap it so each ready site
gets a turn:

```ts
// src/worker.ts
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { perSiteScheduled } from "emdash-multisite/scheduled";
export { PluginBridge };
export default { ...handler, scheduled: perSiteScheduled(createScheduledHandler()) } satisfies ExportedHandler;
```

and add a trigger to `wrangler.jsonc` (`"triggers": { "crons": ["*/5 * * * *"] }`; apply with
`wrangler triggers deploy`, since `versions deploy` does not change triggers). A tick sweeps the
primary and then every site whose status is `ready`, one after another, and a failing site does not
stop the rest. Verified live: scheduled posts on two tenant sites were published by one tick.
Ceiling: a tick takes about (sites x per-site sweep); upgrade path is a Queue with one message per
site, fed by the same loop.

## "Sites" as a tab in the account page (Better Auth UI)
With `emdash-better-auth` >= 0.10.0 the console list can live inside Better Auth UI's account page, next to
Account and Security: `/account/sites`.

```ts
// astro.config.mjs
import { betterAuthUi } from "emdash-better-auth/vite";
export default defineConfig({
  vite: { plugins: [betterAuthUi({ plugins: "emdash-multisite/auth-ui" })] },
  integrations: [emdash({ database: withSites(d1({ binding: "DB" }), { primary: "main", accountTab: true, /* ... */ }) })],
});
```

The host also needs `@better-auth-ui/core` (same version as `emdash-better-auth` uses) and `react` as dependencies.
With `accountTab: true`, `/sites` redirects to `/account/sites` and users land there after signing in. The tab lists
the user's sites with Open site, Open admin and Appearance, and links to `/sites/new` for the create wizard and to
`/sites` for Retry and Delete (the old `/sites` page still serves those until they are ported into the tab).
The tab uses plain React elements and this package's JSON endpoints only, so it has no Better Auth UI hooks.

## Creating sites, limits and recovery
Creating a site = creating a Better Auth organization (`POST /api/auth/organization/create`); the
slug is the site address. The middleware checks the request **before** Better Auth sees it:

| Check | Result |
|---|---|
| slug is not a valid, unreserved DNS label | `400 INVALID_SITE_ADDRESS` |
| signed-in user has an unverified email | `403 EMAIL_NOT_VERIFIED` |
| user already owns `limits.sitesPerUser` sites (failed ones count) | `403 SITE_LIMIT_REACHED` |
| platform already has `limits.totalSites` sites | `503 PLATFORM_FULL` |

Anonymous callers fall through, so Better Auth answers 401 itself. Because every route to
"create an organization" goes through this one path, the Better Auth organization UI is covered too.

Provisioning runs in the background after the 200 and can die (Worker evicted). Recovery:
- `POST /api/multisite/sites/<slug>/retry` — the site's owner or staff. `202` started, `409` if the
  site does not need it.
- `POST /api/multisite/reconcile` — staff only. Re-provisions the **next** stuck site (failed, or
  `provisioning` for over 5 minutes) and reports the rest as `pending`. One site per call, because
  the background budget after a response (~30 s) is shorter than two provisioning runs. Call again
  for the next.

State-changing routes (`retry`, `reconcile`, `theme`) require the `X-EmDash-Request: 1` header (or a
same-origin `Origin`), like core's `/_emdash` APIs; without it they answer `403 CSRF`.

A killed run leaves core's migration lock held; retries release a lock older than 5 minutes
automatically. A site that has tables but no status row (created before status tracking) is
adopted as `ready` instead of being provisioned a second time on top of live content.

## Suspending and deleting sites
A site's operational state lives on the control plane (`multisite:state:<slug>` in `options`), so a
tenant cannot change it. `POST /api/multisite/sites/<slug>/state` with `{ "action": ... }` and the
`X-EmDash-Request: 1` header:

| action | who | effect |
|---|---|---|
| `suspend` | staff | every request to the site answers `503 This site is unavailable`; the owner sees it listed as suspended |
| `resume` | staff | back to active |
| `delete` | owner or staff | soft delete: the site answers `404` (as if it never existed) and disappears from the owner's list; frees one of the owner's site slots; the slug stays taken |
| `restore` | staff | undo a delete |

The fleet page (below) has the matching actions. Better Auth's `organization/delete` is refused on the
control plane (`403 USE_DELETE_SITE`) because it would orphan the site's tables. The state is read on
every tenant request and memoised 30 s per isolate (a change made in an isolate applies to it
immediately).

**Purge.** A deleted site is kept for `deleteGraceDays` (default 14) and then destroyed for good: its
tables are dropped, its organization and members are removed (which frees the slug) and its control-plane
records are cleared. The cron fan-out purges at most one due site per tick; staff can purge earlier with
`POST /api/multisite/sites/<slug>/purge` (`{ "force": true }` skips the grace period). Purging is
idempotent and resumes after a partial run. Not supported: renaming a site (the slug is the table suffix).

## Operating a fleet

- **One shared D1 is single-threaded.** One busy site can slow all. Shard across multiple D1s (by
  site) when a DB gets hot.
- **Time Travel restores the whole DB** — it rewinds every site. Use the per-site backup and restore
  (see "Backups and restore") when only one site is hurt.
- Every EmDash upgrade migrates **every** site's tables (fleet migration, inside one DB).
- Billing is per account (rows read/written), so N sites in one DB cost the same as N DBs. Bots on
  many sites multiply cost — gate signup.

## Limits & gotchas

- **Object cache is not per-site.** Do **not** enable the object cache (`objectCache:`) on a
  multi-site deploy, or cached content can cross sites. R2 media is per-site only through the
  `emdash-multisite/storage` entrypoint; a plain `r2()` descriptor shares one namespace.
- **Sandboxed plugins bypass the wrapper** (their bridge opens its own DB). Use **native** plugins
  only in a multi-site deploy.
- **Cron / scheduled publishing runs for the `primary` site only** (a cron tick has no request, so
  no site). A per-tenant sweep is on the roadmap.
- **SQL rewrite is positional.** A comma-joined second table (`FROM a, b`) or an alias that reuses a
  core table name is not rewritten → fails loudly ("no such table"), never leaks silently.
- **Open signup + unlimited orgs** = unbounded sites = cost risk. Add a per-user cap and
  verified-email gating before public exposure.
- **A stuck `provisioning` status** has no auto-retry yet (provisioning itself is repeatable).

## FAQ

**Why not a plugin?** A plugin can't replace the `database` descriptor and can't patch the build.
Those are exactly the two seams this needs.

**Does it change EmDash core files on disk?** No. It wraps the DB descriptor at runtime and
transforms EmDash's modules **in the build output** via a Vite plugin. The installed `emdash`
package is untouched.

**Can I add it to an existing single site later?** Yes. Make that site the `primary` (unprefixed),
add the three wires, deploy. Its data is untouched; new tenant sites get `$slug` tables.

**Is `emdash-better-auth` required?** Only for the org→site flow and auth. The table-prefix + cache
mechanisms work without it; you'd then provision sites manually via `provisionSite`.

## Package exports

| Import | What |
|---|---|
| `emdash-multisite` | `withSites(inner, sites)`, `resolveSite`, `runAsSite`, `SitesConfig` |
| `emdash-multisite/vite` | `multisiteCaches()` Vite plugin (per-site cache patch + classification) |
| `emdash-multisite/middleware` | `onRequest` outer middleware (hostname→site + org→site glue + status route) |
| `emdash-multisite/db/d1` | runtime entry for the wrapped Cloudflare D1 adapter |
| `emdash-multisite/db/sqlite` | runtime entry for the wrapped SQLite adapter (local dev) |
| `emdash-multisite/provision` | `provisionSite(db, siteId)` / `provisionWith` |
| `emdash-multisite/bootstrap` | `bootstrapControlPlane(db, email)` — one-time control-plane admin + setup flag |

Internal (not a stable API): `src/orgs.ts`, `src/scope.ts`, `src/dialect.ts`, `src/rewrite.ts`,
`src/runtime.ts`.
