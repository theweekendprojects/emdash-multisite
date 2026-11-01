// Merge these into your existing astro.config.mjs. Three wires: the database
// wrapper, the per-site cache Vite plugin, and the outer middleware (+ the
// provisioning/console plugin). See SETUP.md and README.md for the full config
// reference and what each mechanism does.

import { d1, r2 } from "@emdash-cms/cloudflare";
import { multisitePlugin, withSites } from "emdash-multisite";
import { multisiteCaches } from "emdash-multisite/vite";
import emdash from "emdash/astro";
import { defineConfig } from "astro/config";

export default defineConfig({
	// WIRE 2 — per-site caches. Rewrites EmDash's process-wide caches to be
	// per-site at build time. The build fails loudly if a core cache is
	// unclassified; that is the safety net against cross-tenant leaks.
	vite: {
		plugins: [multisiteCaches() /* , ...your other vite plugins */],
	},
	integrations: [
		emdash({
			// WIRE 1 — database wrapper. Each site reads/writes its own prefixed
			// tables (ec_posts$acme). The "primary" site keeps unprefixed names.
			database: withSites(d1({ binding: "DB" }), {
				primary: "main",
				wildcard: "example.com", // slug.example.com -> site "slug" (production)
				// hosts: { "acme.example.com": "acme" }, // test / workers.dev (no wildcard)
				// themes, defaultTheme, limits, appUrl, accountTab, authLinks — see README.
			}),

			// Per-site media in one R2 bucket (keys namespaced per site).
			storage: { ...r2({ binding: "MEDIA" }), entrypoint: "emdash-multisite/storage" },

			// WIRE 3 — outer middleware: hostname -> site, and (on primary)
			// "create a Better Auth organization" -> "provision a site".
			middleware: { outer: "emdash-multisite/middleware" },

			// Provisioning / console / fleet glue (org-create guard, status API,
			// theme switch, customer "My sites" console).
			plugins: [multisitePlugin() /* , ...your other emdash plugins */],
		}),
	],
});
