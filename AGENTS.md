# AGENTS.md — emdash-multisite

Context for an AI agent (or human) opening this repo cold. Read this fully before changing
anything. The README is the user-facing setup guide; this file is the *why*, the architecture, and
the land mines, so you don't rediscover them the hard way.

**PRIVATE.** Do not publish to the public npm registry. The whole point is a private trick kept out
of the open-source `emdash-better-auth`.

---

## What this is, in one paragraph

Run MANY EmDash sites from ONE codebase, ONE Cloudflare Worker, and ONE D1 database — without
Workers for Platforms ($25/mo) and without forking EmDash core. Each site gets its own set of
tables under a name suffix (`ec_posts$acme`, `users$acme`); EmDash's process-wide in-memory caches
are made per-site by a build-time code patch; the request's hostname selects the site; and creating
a Better Auth **organization** provisions a new site whose **slug** is its subdomain. The "primary"
site keeps unprefixed table names, so an existing single-site install is unchanged.

Full session history, decisions, and the open/done checklist live in
`emdash-plan/product/single-db-multisite.md` (separate repo). Read it for the backstory.

## Why NOT a plugin (do not try to make it one)

A plugin cannot replace the **database** descriptor and cannot patch the **build**. Those are the
two seams this needs. So it ships as a package wired into three EmDash config slots the host already
exposes: `database:` (wrapper), `vite.plugins` (cache patch), `middleware.outer` (routing + glue).
It changes **no** EmDash core files on disk — it wraps the DB descriptor at runtime and transforms
EmDash's modules in the *build output* via Vite.

## The three mechanisms (and the files)

1. **Per-site table prefix — `src/rewrite.ts` + `src/dialect.ts`.**
   A wrapped Kysely `Dialect` rewrites the FINAL compiled SQL text: `ec_posts` → `ec_posts$acme`,
   including index/trigger names, FK targets, PRAGMA args, and `sqlite_master` introspection (names
   translated back so core sees its own unprefixed world). Works on TEXT, not the AST, on purpose:
   core's dominant pattern is `` sql`… ${sql.ref(tableName)} …` `` (332 uses) plus ~138 raw literal
   statements, and text rewriting covers all of them at once.
   - `siteDialect(inner, getSite, primary)` wraps a dialect; `runAsSite(site, fn)` sets the active
     site via AsyncLocalStorage (on globalThis).
   - **Shared inner driver:** all per-site Kysely instances share ONE inner driver (WeakMap by inner
     dialect). SQLite has a single connection whose mutex lives in the driver; per-site drivers
     would let one site's transaction swallow another's queries.

2. **Per-site in-memory caches — `src/vite.ts` + `src/scope.ts`.**
   Core keeps ~16 process-wide caches on `globalThis` behind `Symbol.for("emdash:…")` keys, captured
   once per isolate — **site-blind**, so without this one site's settings leak into another (this
   was the central bug, proven on Node). The Vite plugin `multisiteCaches()` rewrites those
   declarations at build time:
   - **HOLDER_KEYS** (declared `const x = g[KEY] ?? (() => {…})()`) → `siteScoped(key, init)` — a
     Proxy with one real object per active site.
   - **SLOT_KEYS** (re-read from the slot on every use via a `const alias = globalThis`) →
     `siteGlobal([keys])` — a globalThis view that routes the listed keys to a per-site map.
   - **SITE_INDEPENDENT_KEYS** — keys that hold no per-site data (build config, per-request state,
     platform health), each with a written reason; left shared on purpose.
   - **FAIL-CLOSED:** the build throws if it finds an EmDash-owned `Symbol.for` key that is in none
     of the three lists, or if a patched declaration no longer matches its expected shape. This is
     the safety net for EmDash upgrades — it refuses to ship a cache that would leak.

3. **Outer middleware + org→site glue — `src/middleware.ts` + `src/orgs.ts` + `src/provision.ts`.**
   `middleware.outer` runs BEFORE EmDash's own middleware, resolves the site from the hostname, and
   wraps the whole request in `runAsSite` so caches and the runtime resolve correctly from line 1.
   On the **primary** (control-plane) site only, it also:
   - guards `POST /api/auth/organization/create` — rejects bad/reserved slugs BEFORE the org exists;
   - after a 200, provisions the site in the background with `after()` (Worker `waitUntil`): run core
     migrations as the new site, copy the org owner into the new site's `users` as admin (role 50,
     verified) + their Better Auth `accounts`/`usernames` rows, inherit auth settings, set title,
     and set `emdash:setup_complete=true`;
   - serves `GET /api/multisite/sites/<slug>` → provisioning status (provisioning/ready/failed).

## File map

| File | Role |
| --- | --- |
| `src/index.ts` | `withSites(inner, sites)` — the DB descriptor wrapper (wire 1). Exports `resolveSite`, `runAsSite`, `SitesConfig`. |
| `src/sites.ts` | `SitesConfig` ({primary, hosts?, wildcard?}), `resolveSite(hostname)`, `assertSitesConfig`. |
| `src/rewrite.ts` | The SQL text rewriter: `rewriteSql`, `rewriteParams`, `translateRows`, `isSiteTable`, `isSiteId`, `suffixFor`. |
| `src/dialect.ts` | `siteDialect()` wraps a Kysely Dialect; `runAsSite`/`currentSite` (ALS on globalThis); shared inner driver. |
| `src/runtime.ts` | `makeRuntime(createInner)` builds the `createDialect`/`createRequestScopedDb` pair a DB descriptor entrypoint needs. |
| `src/db/d1.ts`, `src/db/sqlite.ts` | The wrapped adapter entrypoints EmDash loads (one per inner adapter). |
| `src/scope.ts` | `siteScoped()` / `siteGlobal()` + the globalThis `scopeState()` (primary, inner dialect, activeSite, siteOfDb, holders, slots). |
| `src/vite.ts` | `multisiteCaches()` Vite plugin + the three cache key lists + the fail-closed patcher. |
| `src/middleware.ts` | `onRequest` outer middleware: hostname→site, org-create guard+glue, status route. |
| `src/orgs.ts` | `slugProblem`, `createSiteForOrg`, `parseCreatedOrg`, `readStatus`, `RESERVED_SITE_IDS`, `ORG_CREATE_PATH`. |
| `src/provision.ts` | `provisionSite(db, siteId)` / `provisionWith` — run core migrations as a site. |
| `src/bootstrap.ts` | `bootstrapControlPlane(db, email)` — one-time: promote the primary site's first user to admin + set setup flag. |
| `scripts/selfcheck.ts` | Oracle: real core migrations + repositories through the wrapper, isolation asserts. |
| `scripts/caches.selfcheck.ts` | Cache tripwire: scans `emdash` + all `@emdash-cms/*` for unclassified/reshaped caches. |
| `scripts/orgs.selfcheck.ts` | Slug validation + org-response parsing (no deps). |

## How a site selects its "active site" (subtle, read this)

`activeSite()` in `scope.ts`, in order:
1. the request's DB handle (core stores a per-request Kysely in its request context;
   `scopeState().siteOfDb` maps that handle → site), else
2. `runAsSite()`'s AsyncLocalStorage value (set by the middleware and by provisioning), else
3. the `primary` site.

So the hostname→site decision happens once in the outer middleware; everything downstream (caches,
runtime, every query) reads it from ALS/the request db. There is no per-call site argument.

## GOTCHAS — the land mines, each one cost real time

- **Caches are site-blind by default. This is THE bug.** EmDash assumes one isolate = one site. If
  you add any cache or a new EmDash release adds one, it leaks across sites unless classified. The
  tripwire (`scripts/caches.selfcheck.ts`, and the build itself) is what catches this. Never silence
  it; classify the key.

- **The cache patch targets EmDash's code shape.** `src/vite.ts` matches specific declaration shapes
  in core's compiled + source modules. An EmDash upgrade can change them. The build FAILS LOUDLY
  with the offending key/file. On every EmDash bump: run the tripwire in staging, update
  `HOLDER_KEYS`/`SLOT_KEYS`/`SITE_INDEPENDENT_KEYS` or the shape regexes, then deploy. There is a
  `patchSlots` subtlety: an alias like `holder`/`g` is reused by unrelated functions, so the slot
  patch binds to the NEAREST `alias = globalThis` BEFORE the first use of the key, not the first one
  in the file. A past bug patched the wrong one; the selfcheck now verifies the binding.

- **SQL rewrite is positional, not a parser.** It suffixes a table name only when it follows
  FROM/JOIN/INTO/UPDATE/TABLE/REFERENCES/EXISTS/TO, after `ON` in a trigger/index, or before a `.`
  qualifier. A comma-joined second table (`FROM a, b`) or an alias that reuses a core table name is
  NOT rewritten → fails loudly ("no such table/column"), never leaks silently. If core ever emits
  such SQL for a tenant table, extend `rewriteSql`.

- **CREATE TRIGGER … ON <table>** must suffix the table after `ON` (a trigger body also references
  tables). This was a real leak (a non-primary site's triggers fired on the primary's tables). The
  `isTrigger` branch handles it; the migration oracle asserts triggers fire on their own site.

- **Internal/cron DB handle.** Core's auth routes and cron ask for a DB with the fixed URL
  `https://cron.emdash.internal/`. That URL carries no site, so `runtime.ts` uses the middleware's
  current site for `*.emdash.internal`, not the hostname. Without this, accounts created on a tenant
  host were written to the primary. If core adds another internal URL, handle it the same way.

- **`$` is the suffix marker on purpose.** A collection slug can legally contain `__` but never `$`.
  Don't switch to `__`. Site ids are DNS labels: `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$` — inner
  hyphens allowed, so suffix-stripping regexes must treat `-` as part of the name (see the lookahead
  in `translateRows`).

- **`users` is per-site.** That is what gives per-site roles with no change to core RBAC. A person
  managing N sites has N `users` rows (one per site) + one Better Auth identity on the control plane.
  Org-admin on the control plane must NEVER imply CMS-admin on a tenant (issue #4 rule).

- **The setup wizard must never run on any site.** Sites are born with an admin outside EmDash's
  first-run wizard, which then refuses with "admin user already exists". Tenant sites get
  `emdash:setup_complete=true` from provisioning. The control-plane site's first user signs up via
  Better Auth as a *subscriber*, so run `bootstrapControlPlane(db, email)` ONCE to promote them and
  set the flag. See README "First admin & the setup wizard".

- **Object cache + R2 are NOT per-site yet.** Do not enable `objectCache:` on a multi-site deploy
  until a per-site key prefix is added (the object-cache key has only a static `keyPrefix`; R2 keys
  are tenant-blind). Media could cross sites otherwise.

- **Sandboxed plugins bypass the wrapper** (their bridge opens its own DB). Native plugins only in
  a multi-site deploy, for now.

- **Cron / scheduled publishing runs for the primary site only** (a cron tick has no request → no
  site). A per-tenant sweep is not built yet.

- **`workers.dev` has no wildcard subdomains.** Preview deploys must map each hostname in
  `SitesConfig.hosts` and use `wrangler versions upload --preview-alias <name>`. Real
  `slug.yourdomain.com` needs a custom domain + wildcard DNS record + route.

- **Node version:** tooling/self-checks need Node ≥ 22.18 (native TS). On this project's dev machine
  that is `~/.nvm/versions/node/v22.23.2/bin/node`. The default `node` in these dirs was v20 and
  breaks pnpm + TS execution.

- **Local dev needs shims that are NOT in this package.** On macOS < 13.5 you can't run `workerd`,
  so dev uses the Node adapter + SQLite with: a `cloudflare:workers` alias, `ssr.noExternal` for
  HeroUI/Better-Auth-UI, and an `optimizeDeps` entry for `bowser`. See the `multisite-smoke-node`
  repo. These are dev-only; Cloudflare needs none of them.

- **D1 atomic batches bypass the connection rewrite.** On D1 (no transactions),
  core calls `adapter.executeAtomicBatch(queries)` for content writes, block
  types and similar. That path never acquires a connection, so without a wrap
  those writes land in the PRIMARY site's tables (or collide with its rows,
  e.g. `Block type "marketing_hero" already exists`). `dialect.ts` `scopeBatch`
  wraps the adapter with the same rewrite. Any new adapter-level entry point in
  core needs the same treatment.
- **Seeding a new site needs `includeContent: true`** or the site has
  collections but no entries. Seeding writes `site:title`; the org-name title
  write must stay after it.

## How to verify a change (always do this)

Run with Node ≥ 22.18:
```
node --no-warnings scripts/caches.selfcheck.ts <path-to-a-consuming-site>/node_modules   # cache tripwire
node --no-warnings scripts/orgs.selfcheck.ts                                             # slug/parse
node --no-warnings scripts/selfcheck.ts    # migrations+repos oracle (run from/with a site that has `emdash` installed)
```
Then build a consuming site and smoke-test two hostnames mapping to two sites (titles must not
cross; see the two companion repos). `tsc -p tsconfig.json` must be clean. The real gate for the
cache patch is: the build does not throw and the two-site title test stays separate under
concurrency.

## Companion repos (same org, all PRIVATE)

- `theweekendprojects/multisite-smoke` — Cloudflare reference site (the real deploy test).
- `theweekendprojects/multisite-smoke-node` — Node+SQLite local-dev lab (carries the dev shims + the
  `scripts/{provision,set-option,set-title}.ts` tooling used during development).
- `emdash-plan` (`product/single-db-multisite.md`) — full history + done/open checklist.

## Branch policy

**One branch: `main`.** No feature branches on the remote. Commit to `main`, push `main`.

## What is proven vs open

Proven (see `emdash-plan/product/single-db-multisite.md` §4): isolation on Node + real Worker/D1,
real core migrations through the wrapper, all ~16 caches patched + tripwire, org→site end to end,
cross-site auth isolation, no-wizard setup.

Open (that doc §9): real wildcard subdomain routing; harden signup (per-user org cap, verified-email
gate, stuck-provisioning recovery); "My sites" dashboard + login handoff; object cache + R2 per-site
prefix; per-tenant cron; org delete/rename → site lifecycle; one `emdashMultisite()` integration +
starter template; measure per-site runtime memory; snapshot-based provisioning; tear down the public
test Worker.

Append nothing here per session — update `emdash-plan/product/single-db-multisite.md`'s discussion
log instead. Keep this file about the code and its gotchas.
