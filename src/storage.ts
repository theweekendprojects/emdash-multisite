/**
 * Runtime storage entrypoint: one shared R2 bucket, one key prefix per site.
 *
 * Core caches ONE storage instance for the whole Worker, so the site is read on
 * every call (from `runAsSite`, set by the middleware), not when the instance is
 * built. Keys stored in a site's `media` table stay unprefixed; the prefix is
 * added here and removed from listings, so a site can only ever name its own
 * objects, whatever key a request carries.
 *
 * Host config:
 *   storage: { ...r2({ binding: "MEDIA" }), entrypoint: "emdash-multisite/storage" }
 */
import { sql } from "kysely";
import { createStorage as createR2 } from "@emdash-cms/cloudflare/storage/r2";
import { EmDashStorageError, type Storage } from "emdash";
import { currentSite } from "./dialect.ts";
import { sitesConfig } from "./config.ts";
import { controlDb } from "./registry.ts";
import { mediaKey, unmediaKey } from "./rules.ts";
import { scopeState } from "./scope.ts";

const site = (): string => currentSite() ?? scopeState().primary;

/** Throws when the active site is at or over `limits.mediaBytesPerSite`. */
async function assertQuota(): Promise<void> {
	const cap = sitesConfig()?.limits?.mediaBytesPerSite;
	if (cap === undefined) return;
	const r = await sql<{ used: number | null }>`SELECT SUM(size) AS used FROM media`.execute(controlDb());
	// ponytail: checked before the upload, so one file can overshoot the cap. Upgrade path: pass the size in.
	if ((r.rows[0]?.used ?? 0) >= cap) throw new EmDashStorageError("Media storage limit reached for this site", "QUOTA_EXCEEDED");
}

export function createStorage(config: Record<string, unknown>): Storage {
	const inner = createR2(config);
	const publicUrl = typeof config.publicUrl === "string";
	const getPublicUrl = (key: string) => inner.getPublicUrl(publicUrl ? mediaKey(site(), key) : key);
	return {
		async upload(o) {
			await assertQuota();
			const r = await inner.upload({ ...o, key: mediaKey(site(), o.key) });
			return { ...r, key: o.key, url: getPublicUrl(o.key) };
		},
		// ponytail: `o` (byte range) exists in current core only; `any` keeps older typings compiling.
		download: (key: string, o?: any) => (inner.download as any)(mediaKey(site(), key), o),
		delete: (key) => inner.delete(mediaKey(site(), key)),
		exists: (key) => inner.exists(mediaKey(site(), key)),
		async list(o: { prefix?: string; limit?: number; cursor?: string } = {}) {
			const s = site();
			const r = await inner.list({ ...o, prefix: mediaKey(s, o.prefix ?? "") });
			return { ...r, files: r.files.flatMap((f) => { const k = unmediaKey(s, f.key); return k === null ? [] : [{ ...f, key: k }]; }) };
		},
		getSignedUploadUrl: (o) => inner.getSignedUploadUrl(o),
		// Served through the host (`/_emdash/api/media/file/<key>`), which the site's own request already scopes.
		// A configured CDN `publicUrl` has no such scoping, so its URLs carry the prefix.
		getPublicUrl,
	};
}
