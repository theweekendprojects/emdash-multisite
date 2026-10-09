/**
 * Signed one-time handoff from the control plane to a tenant site.
 *
 * Cookies are per host, so a user signed in on the control plane is a stranger
 * on `acme.example.com`. "Open admin" therefore goes through a short-lived link
 * the control plane signs for (user, site); the tenant checks it and starts the
 * user's session there. Pure crypto only, so it runs under plain Node for the
 * self-check; storage of the secret and of used nonces lives in registry.ts.
 */
const enc = new TextEncoder();

export interface HandoffClaims {
	/** The user's id (the same id on the control plane and in the tenant copy). */
	uid: string;
	/** The tenant site the link is for. */
	site: string;
	/** Expiry, ms since epoch. */
	exp: number;
	/** Random id, accepted once. */
	nonce: string;
}

/** A signed link lives this long. It only has to survive one redirect. */
export const HANDOFF_TTL_MS = 60_000;

const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const fromB64url = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

async function hmac(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function signHandoff(secret: string, claims: Omit<HandoffClaims, "nonce" | "exp">, now = Date.now()): Promise<string> {
	const full: HandoffClaims = { ...claims, exp: now + HANDOFF_TTL_MS, nonce: b64url(crypto.getRandomValues(new Uint8Array(16))) };
	const body = b64url(enc.encode(JSON.stringify(full)));
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmac(secret), enc.encode(body)));
	return `${body}.${b64url(sig)}`;
}

/** The claims if the token is genuine, unexpired and for `site`; otherwise null. */
export async function verifyHandoff(secret: string, token: string, site: string, now = Date.now()): Promise<HandoffClaims | null> {
	const [body, sig, extra] = token.split(".");
	if (!body || !sig || extra !== undefined) return null;
	try {
		const ok = await crypto.subtle.verify("HMAC", await hmac(secret), fromB64url(sig), enc.encode(body));
		if (!ok) return null;
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(body))) as Partial<HandoffClaims>;
		if (typeof claims.uid !== "string" || typeof claims.nonce !== "string" || typeof claims.exp !== "number") return null;
		if (claims.site !== site || claims.exp < now) return null;
		return claims as HandoffClaims;
	} catch {
		return null;
	}
}
