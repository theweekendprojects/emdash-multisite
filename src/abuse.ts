/**
 * Brakes on automated abuse of open sign-up. Uses Cloudflare's Rate Limiting
 * bindings when the host declares them, and does nothing when it does not:
 *   SIGNUP_LIMITER  keyed by client IP    (sign-up requests)
 *   CREATE_LIMITER  keyed by user id      (site creation)
 * Declare them in wrangler.jsonc, e.g.
 *   "ratelimits": [{ "name": "SIGNUP_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }]
 * ponytail: counters are per Cloudflare location and periods are 10 or 60 s, so this stops
 * bursts, not slow trickles. Upgrade path: Turnstile on sign-up (needs a site key).
 */
import { platformEnv } from "./platform-env.ts";

export type Limiter = "SIGNUP_LIMITER" | "CREATE_LIMITER";

/** True when `key` is over the limit of the named binding. Fails open (no binding, or it errors). */
export async function overLimit(name: Limiter, key: string): Promise<boolean> {
	const binding = (await platformEnv())?.[name] as { limit(o: { key: string }): Promise<{ success: boolean }> } | undefined;
	if (!binding) return false;
	try {
		return !(await binding.limit({ key })).success;
	} catch {
		return false;
	}
}
