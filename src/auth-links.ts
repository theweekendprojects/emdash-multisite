/**
 * Which account links a theme header shows. Pure, so a plain-Node self-check covers it; the host's
 * `AuthLinks.astro` component calls it and prints the result as plain `<a>` elements: no script, no extra request.
 *
 * - visitor, public sign-up on:  Sign in, Sign up
 * - visitor, public sign-up off: nothing
 * - signed in:                   My account, and Admin from the author role (30) up (unless the theme draws its own)
 */
import { t } from "./i18n.ts";

export interface AuthLink {
	label: string;
	href: string;
	/** The call to action (Sign up). */
	cta?: boolean;
}

export function authLinksFor(opts: { signup: boolean; account: string; user: { role?: number } | null | undefined; admin?: boolean }): AuthLink[] {
	if (!opts.user) return opts.signup ? [{ label: t("links.signIn"), href: "/login" }, { label: t("links.signUp"), href: "/signup", cta: true }] : [];
	const links: AuthLink[] = [{ label: t("links.account"), href: opts.account }];
	if (opts.admin !== false && (opts.user.role ?? 0) >= 30) links.push({ label: t("links.admin"), href: "/_emdash/admin" });
	return links;
}
