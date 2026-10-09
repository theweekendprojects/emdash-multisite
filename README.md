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
      storage: r2({ binding: "MEDIA" }),
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

Seeds are applied with `skipMediaDownload`: object storage is shared across sites, so seed images
are skipped rather than written to a bucket every site shares.

## Opening a tenant's admin (handoff)
Cookies are per host, so a user signed in on the control plane is signed out on `acme.example.com`.
"Open admin" on `/sites` therefore goes to `/sites/<slug>/open-admin` on the control plane, which
checks the user may manage the site, signs a link (HMAC-SHA256, 60 s, bound to user and site, one
nonce) and redirects to `https://<site>/_multisite/handoff?t=...`. The tenant verifies the link,
accepts its nonce once, checks the user exists on that site, starts the user's session there and
redirects to `/_emdash/admin`. Replayed, tampered, expired or wrong-site links get `403`. The
signing key is created on first use and stored on the control plane (`multisite:handoff-secret`),
so no environment secret is shared. This signs the **owner** in; it does not sync passwords (a
password changed on the control plane does not change the tenant's copy; backlog OP-05).

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

The fleet page has the matching buttons. Better Auth's `organization/delete` is refused on the
control plane (`403 USE_DELETE_SITE`) because it would orphan the site's tables. The state is read on
every tenant request and memoised 30 s per isolate (a change made in an isolate applies to it
immediately). **Not done:** purging a deleted site's ~90 tables and its organization after a grace
period (the data stays in D1), and renaming (the slug is the table suffix).

## Operating a fleet

- **One shared D1 is single-threaded.** One busy site can slow all. Shard across multiple D1s (by
  site) when a DB gets hot.
- **Time Travel restores the whole DB** — there is no per-site rollback. For per-site backups, do a
  per-site D1→R2 export.
- Every EmDash upgrade migrates **every** site's tables (fleet migration, inside one DB).
- Billing is per account (rows read/written), so N sites in one DB cost the same as N DBs. Bots on
  many sites multiply cost — gate signup.

## Limits & gotchas

- **Object cache and R2 are not per-site yet.** Do **not** enable the object cache (`objectCache:`)
  on a multi-site deploy until the per-site key prefix is added, or cached content/media can cross
  sites. Keep media isolation in mind.
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
