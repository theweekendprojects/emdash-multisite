# Setup — wire emdash-multisite into an EmDash + Cloudflare app

This is the copy-paste wiring to turn a normal single-site EmDash app (Astro +
`@astrojs/cloudflare` + D1) into a multi-tenant one: many sites, one Worker, one
D1 database, subdomain-per-site.

> Prefer one command? `npx create-emdash-multisite` scaffolds all of this into an
> existing EmDash app. This file is the manual reference for what that does and
> for customising it.

**Prerequisites**
- An EmDash app that already builds and deploys to Cloudflare Workers with a D1
  binding (`@emdash-cms/cloudflare`, `d1({ binding: "DB" })`).
- `emdash` ≥ 0.30, `kysely` ≥ 0.29, Node ≥ 22.18.
- Install: `pnpm add emdash-multisite` (or npm/yarn).

There are **four** edits. Three are in `astro.config.mjs`; one is `src/worker.ts`
plus two lines of `wrangler.jsonc`. Read the main `README.md` for what each
mechanism does and the gotchas; this file is just the wiring.

---

## 1. `astro.config.mjs` — the three wires

```js
// --- add these imports ---
import { d1, r2 } from "@emdash-cms/cloudflare";
import { multisitePlugin, withSites } from "emdash-multisite";
import { multisiteCaches } from "emdash-multisite/vite";
import emdash from "emdash/astro";

export default defineConfig({
  // WIRE 2 — per-site caches. Add the Vite plugin so EmDash's process-wide
  // caches are rewritten to be per-site at build time. Without this, one
  // tenant's cached settings/collections/etc. leak into another. The build
  // fails loudly if a core cache is unclassified (that is the safety net).
  vite: {
    plugins: [multisiteCaches()],
    // ...your other vite plugins
  },
  integrations: [
    emdash({
      // WIRE 1 — database wrapper. withSites() wraps your D1 descriptor so each
      // site reads/writes its own prefixed tables (ec_posts$acme). The "primary"
      // site keeps unprefixed names, so an existing single-site install is
      // unchanged.
      database: withSites(d1({ binding: "DB" }), {
        primary: "main",            // the control-plane site (unprefixed tables)
        wildcard: "example.com",    // slug.example.com -> site "slug" (production)
        // hosts: { "acme.example.com": "acme" },  // explicit host->site (test/workers.dev)
        // themes, defaultTheme, limits, appUrl, accountTab, authLinks — see README.
      }),

      // Per-site media in one R2 bucket (keys are namespaced per site).
      storage: { ...r2({ binding: "MEDIA" }), entrypoint: "emdash-multisite/storage" },

      // WIRE 3 — outer middleware. Resolves the site from the request hostname
      // before EmDash reads anything, and (on the primary site) turns "create a
      // Better Auth organization" into "provision a site".
      middleware: { outer: "emdash-multisite/middleware" },

      // The provisioning / console / fleet glue (org-create guard, status API,
      // theme switch, customer "My sites" console).
      plugins: [multisitePlugin()],
    }),
  ],
});
```

`primary` is the only required field. `wildcard` (production) or `hosts`
(test / `workers.dev`, which has no wildcard subdomains) decides how a hostname
maps to a site. Full config reference: `README.md`.

---

## 2. `src/worker.ts` — the host-aware edge cache

Cloudflare Workers Cache keys entries by **path + query, not hostname**, and one
Worker serves every tenant. So the host must go into the cache key via a cached
inner entrypoint. This is the one piece that cannot live inside the npm package
(it is per-project Cloudflare Worker config). Copy this file:

```ts
import handler, { createScheduledHandler } from "@emdash-cms/cloudflare/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  EDGE_REQUEST_HEADER,
  cacheableRequest,
  guardResponse,
  normalizeHost,
} from "emdash-multisite/edge-cache";
import { perSiteScheduled } from "emdash-multisite/scheduled";

/** Inner entrypoint: Workers Cache is ON here only; `props.host` is part of the key. */
export class PublicCache extends WorkerEntrypoint<Env, { host: string; gpc: boolean }> {
  async fetch(request: Request): Promise<Response> {
    const headers = new Headers(request.headers);
    headers.set(EDGE_REQUEST_HEADER, "1"); // ask the middleware to tag the response with its site
    const res = await handler.fetch(
      new Request(request, { headers }) as never,
      this.env as never,
      this.ctx as never,
    );
    return guardResponse(res as Response); // default-deny: only a clean anonymous 200 is stored
  }
  /** Purges only work from inside the cached entrypoint, so callers RPC here. */
  async purgeTag(tags: string[]) {
    const { cache } = await import("cloudflare:workers");
    return cache.purge({ tags });
  }
}

type Gateway = {
  exports: Record<string, (o: { props: { host: string; gpc: boolean } }) => Fetcher>;
};

export default {
  ...handler,
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    // Not cacheable (signed-in, non-GET, has query, admin/api): straight through, uncached.
    if (!cacheableRequest(request.method, url, request.headers)) {
      return handler.fetch(request as never, env as never, ctx as never);
    }
    const props = { host: normalizeHost(url.hostname), gpc: request.headers.get("sec-gpc") === "1" };
    return (ctx as unknown as Gateway).exports.PublicCache({ props }).fetch(request);
  },
  // EmDash's scheduled handler serves one site; run it once per ready site.
  scheduled: perSiteScheduled(createScheduledHandler() as never) as ExportedHandler["scheduled"],
} satisfies ExportedHandler;
```

> If you render comments/forms behind Turnstile, or want immutable cache headers
> on `/_image` and media, see the extended `worker.ts` in the reference host app
> (link in README). Those are optional add-ons, not required for multi-site.

---

## 3. `wrangler.jsonc` — point `main` at the Worker and declare the two entrypoints

```jsonc
{
  "main": "./src/worker.ts",

  // Host-aware edge cache: the default (gateway) entrypoint is uncached; the
  // PublicCache entrypoint is cached, with the host in ctx.props.
  "cache": { "enabled": true },
  "exports": {
    "default": { "type": "worker", "cache": { "enabled": false } },
    "PublicCache": { "type": "worker", "cache": { "enabled": true } }
  }

  // ...your existing d1_databases (binding "DB"), r2_buckets (binding "MEDIA"),
  //    kv, routes / custom_domain, compatibility_date, etc.
}
```

For production subdomains you also need, on the Cloudflare side:
- a **custom domain** route for the apex, and a route for `*.example.com`,
- a **wildcard DNS** record (`*` → the Worker, proxied).

On a `workers.dev` test Worker there is no wildcard: map each tenant hostname in
`hosts` and deploy with `wrangler versions upload --preview-alias <name>`.

---

## 4. First admin (run once)

Tenant sites are born with an admin, so EmDash's first-run setup wizard never
runs on them. The **primary** (control-plane) site's first user signs up through
Better Auth as a normal subscriber — promote them once:

```ts
import { bootstrapControlPlane } from "emdash-multisite/bootstrap";
// run once against the primary site's DB, with the user's email
await bootstrapControlPlane(db, "you@example.com");
```

See `README.md` → "First admin & the setup wizard".

---

## Verify

From the package (Node ≥ 22.18):

```bash
# cache tripwire: scans your installed emdash + @emdash-cms/* for unclassified caches
node --no-warnings node_modules/emdash-multisite/scripts/caches.selfcheck.ts ./node_modules
```

Then build, deploy, and open **two** hostnames mapping to two sites. Set a
different site title on each; the titles must not cross. That two-site title test
under concurrency is the real gate.

## Don'ts (the short list — full list in README "Limits & gotchas")

- Don't enable Workers Cache any other way (`cacheCloudflare()`, `routeRules`
  maxAge): its key ignores the host and will cross tenants.
- Don't enable the EmDash object cache or assume R2 is per-site yet (keys are not
  namespaced per site — media could cross).
- Don't save platform secrets in the control-plane admin settings: provisioning
  copies auth settings into every tenant. Use Worker secrets / env instead.
- On every EmDash core upgrade, re-run the cache tripwire in staging before
  deploying — a new core cache fails the build until you classify it.
