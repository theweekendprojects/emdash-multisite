// src/worker.ts — host-aware edge cache for a multi-tenant EmDash app.
//
// Copied in by `npx create-emdash-multisite` (or by hand from SETUP.md). This is
// the one piece that cannot live inside the npm package: it is per-project
// Cloudflare Worker config.
//
// Why it exists: Cloudflare Workers Cache keys entries by path + query, NOT by
// hostname, and one Worker serves the apex and every tenant subdomain. So the
// host is put into the cache key via `ctx.props` of a cached inner entrypoint.
// Two entrypoints (declared in wrangler.jsonc `exports`):
//   default      gateway, caching OFF. Runs every request, decides cacheable or not.
//   PublicCache  caching ON. Runs the normal handler; the response guard is
//                default-deny (only a clean anonymous 200 of an allowed type is stored).
import handler, { createScheduledHandler } from "@emdash-cms/cloudflare/worker";
import { WorkerEntrypoint } from "cloudflare:workers";
import {
	EDGE_REQUEST_HEADER,
	cacheableRequest,
	guardResponse,
	normalizeHost,
} from "emdash-multisite/edge-cache";
import { perSiteScheduled } from "emdash-multisite/scheduled";

/** Inner entrypoint: Workers Cache is enabled for THIS entrypoint only. `props.host` is part of the key. */
export class PublicCache extends WorkerEntrypoint<Env, { host: string; gpc: boolean }> {
	async fetch(request: Request): Promise<Response> {
		// Ask the multisite middleware to label the response with its site (used for the purge tag).
		const headers = new Headers(request.headers);
		headers.set(EDGE_REQUEST_HEADER, "1");
		const res = await handler.fetch(
			new Request(request, { headers }) as never,
			this.env as never,
			this.ctx as never,
		);
		return guardResponse(res as Response);
	}
	/** Purges only work from inside the cached entrypoint (from the gateway they report success and do nothing), so callers RPC here. */
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
