/**
 * The media R2 bucket as a raw binding, for work outside a request's storage wrapper:
 * deleting a site's files on purge, and keeping site backups. Shared code, so it reaches the
 * binding through `platformEnv()` (no static `cloudflare:workers` import).
 */
// @ts-ignore - virtual module provided by EmDash's integration
import emdashConfig from "virtual:emdash/config";
import { platformEnv } from "./platform-env.ts";
import { backupPrefix, mediaKey } from "./rules.ts";

export interface Bucket {
	list(o: object): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
	delete(keys: string | string[]): Promise<void>;
	put(key: string, value: string): Promise<unknown>;
	get(key: string): Promise<{ text(): Promise<string> } | null>;
}

/** The bucket named by the host's `storage` config, or undefined (no R2, or not on Workers). */
export async function mediaBucket(): Promise<Bucket | undefined> {
	const binding = (emdashConfig as { storage?: { config?: { binding?: string } } }).storage?.config?.binding;
	return binding ? ((await platformEnv())?.[binding] as Bucket | undefined) : undefined;
}

/** Delete every object under a prefix. Returns how many were removed. */
async function deletePrefix(bucket: Bucket, prefix: string): Promise<number> {
	let n = 0, cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		if (page.objects.length) await bucket.delete(page.objects.map((o) => o.key));
		n += page.objects.length;
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return n;
}

/**
 * Delete a site's uploaded files and its backups (used on purge: a deleted customer's data must not
 * outlive the grace period). Returns the number removed; 0 when no R2 storage is configured.
 */
export async function purgeSiteMedia(slug: string): Promise<number> {
	const bucket = await mediaBucket();
	if (!bucket) return 0;
	return (await deletePrefix(bucket, mediaKey(slug, ""))) + (await deletePrefix(bucket, backupPrefix(slug)));
}
