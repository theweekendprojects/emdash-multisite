/**
 * The Workers bindings (`env`), or undefined off Workers (Node/SQLite lab).
 * Imported at run time, through a variable, so bundlers for other platforms do not
 * try to resolve `cloudflare:workers` and fail the build.
 */
let cached: Promise<Record<string, unknown> | undefined> | undefined;
export function platformEnv(): Promise<Record<string, unknown> | undefined> {
	const specifier = "cloudflare:workers";
	return (cached ??= import(/* @vite-ignore */ specifier).then((m) => m.env as Record<string, unknown>).catch(() => undefined));
}
