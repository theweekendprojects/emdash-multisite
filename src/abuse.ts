/**
 * Brakes on automated abuse of open sign-up. Uses Cloudflare's Rate Limiting
 * bindings when the host declares them, and does nothing when it does not:
 *   SIGNUP_LIMITER    keyed by client IP    (sign-up requests)
 *   CREATE_LIMITER    keyed by user id      (site creation, per user)
 *   CREATE_IP_LIMITER keyed by client IP    (site creation, per IP - OP-13)
 * Declare them in wrangler.jsonc, e.g.
 *   "ratelimits": [{ "name": "SIGNUP_LIMITER", "namespace_id": "1001", "simple": { "limit": 5, "period": 60 } }]
 * ponytail: counters are per Cloudflare location and periods are 10 or 60 s, so this stops
 * bursts, not slow trickles. Upgrade path: Turnstile on sign-up (needs a site key).
 */
import { platformEnv } from "./platform-env.ts";

export type Limiter = "SIGNUP_LIMITER" | "CREATE_LIMITER" | "CREATE_IP_LIMITER";

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

/**
 * OP-13: Turnstile verification on sign-up.
 * Verifies the Turnstile token sent by the client. When TURNSTILE_SECRET env var
 * is unset (dev/test), the check is skipped (fails open).
 * Returns null if verified, or an error response if failed/missing.
 */
export async function verifyTurnstile(token: string | undefined, remoteIp: string | undefined): Promise<Response | null> {
	const secret = (await platformEnv())?.TURNSTILE_SECRET;
	// No secret configured (dev/test, or Turnstile not enabled): skip entirely, including the token check,
	// so the sign-up flow is unchanged until an operator sets TURNSTILE_SECRET and renders the widget.
	if (typeof secret !== "string" || secret === "") return null;

	const fail = (code: string, message: string) =>
		new Response(JSON.stringify({ code, message }), {
			status: 403,
			headers: { "content-type": "application/json", "cache-control": "no-store" },
		});
	// Secret is set, so the client must send a token.
	if (!token) return fail("TURNSTILE_MISSING", "Security check failed. Please try again.");

	try {
		const formData = new FormData();
		formData.append("response", token);
		formData.append("secret", secret);
		if (remoteIp) formData.append("remoteip", remoteIp);

		const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			body: formData,
		});

		const outcome = (await result.json()) as { success: boolean; "error-codes"?: string[] };
		if (!outcome.success) return fail("TURNSTILE_FAILED", `Security check failed: ${outcome["error-codes"]?.join(", ") ?? "Invalid token"}`);
		return null;
	} catch {
		// Network error - fail open to avoid blocking legitimate users
		return null;
	}
}
