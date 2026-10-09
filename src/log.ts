/**
 * One JSON line per notable event, so Workers Logs (set `"observability": { "enabled": true }` in wrangler.jsonc)
 * can filter and count them: `event = "site.ready"`, `event = "signup.rate_limited"`, ...
 * Never log secrets, passwords, tokens or full email addresses.
 */
export const log = (event: string, fields: Record<string, unknown> = {}): void => console.log(JSON.stringify({ app: "multisite", event, ...fields }));
