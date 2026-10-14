/**
 * Self-check for the abuse helpers (OP-13), exercising the real functions.
 *
 * Off Workers there are no rate-limit bindings and no `cloudflare:workers`, so:
 *  - `overLimit` fails open (returns false) for every limiter, including the new per-IP one;
 *  - `verifyTurnstile` has no secret, so it skips the check and returns null even with no token.
 * These are the behaviours the middleware relies on to keep dev/test unchanged.
 *
 * Run: node --no-warnings scripts/abuse.selfcheck.ts
 */
import { strictEqual } from "node:assert";
import { overLimit, verifyTurnstile } from "../src/abuse.ts";

let failed = 0;
const check = async (name: string, got: unknown, want: unknown) => {
	try {
		strictEqual(await got, want);
		console.log(`PASS  ${name}`);
	} catch {
		failed++;
		console.log(`FAIL  ${name} (got ${JSON.stringify(await got)})`);
	}
};

// overLimit fails open with no binding — for every limiter name, including the new CREATE_IP_LIMITER.
await check("SIGNUP_LIMITER fails open", overLimit("SIGNUP_LIMITER", "1.2.3.4"), false);
await check("CREATE_LIMITER fails open", overLimit("CREATE_LIMITER", "user-1"), false);
await check("CREATE_IP_LIMITER fails open (OP-13)", overLimit("CREATE_IP_LIMITER", "1.2.3.4"), false);

// verifyTurnstile skips when no secret is configured (dev/test): null even without a token.
await check("Turnstile skips with no secret, no token", verifyTurnstile(undefined, undefined).then((r) => r), null);
await check("Turnstile skips with no secret, with token", verifyTurnstile("some-token", "1.2.3.4").then((r) => r), null);

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
