/**
 * User-facing strings of this package (console, account "Sites" tab, Fleet, the site's admin page,
 * handoff and status pages, API error messages), in one catalog keyed by message id.
 *
 * - `t(key, params)` returns the string with `{named}` placeholders filled in.
 * - `tn(base, count, params)` picks `<base>.one` or `<base>.other` with `Intl.PluralRules`, so a
 *   language with other plural rules only needs its own pair of strings.
 * - `tHtml(key, params)` is `t` with the text and every param HTML-escaped, for server-rendered HTML.
 * - `messagesFor(prefix)` is the slice of the catalog a client script needs (the console page embeds
 *   only `console.*` as JSON, not the whole catalog).
 *
 * Pure and dependency-free: it runs under plain Node (scripts/i18n.selfcheck.ts), in the Worker and
 * in the browser (auth-ui.ts imports it). English only for now; the locale is fixed, and nothing here
 * reads the request, so cache keys, the SQL rewrite and the per-site caches are untouched.
 */

const en = {
	// ---- console (/sites, /sites/new, /sites/<slug>/appearance), server shell ----
	"console.page.title.list": "My sites",
	"console.page.title.new": "Create a site",
	"console.page.title.appearance": "Appearance",
	"console.page.brand": "Sites",
	"console.page.navLabel": "Main",
	"console.page.loading": "Loading…",

	// ---- console, client script (embedded as JSON) ----
	"console.nav.sites": "My sites",
	"console.nav.teams": "Teams",
	"console.nav.account": "Account",
	"console.nav.fleet": "Fleet",
	"console.status.provisioning": "setting up",
	"console.status.ready": "ready",
	"console.status.failed": "failed",
	"console.status.unknown": "unknown",
	"console.status.suspended": "suspended",
	"console.role.owner": "owner",
	"console.role.admin": "admin",
	"console.role.member": "member",
	"console.list.title": "My sites",
	"console.list.openSite": "Open site",
	"console.list.openAdmin": "Open admin",
	"console.list.noUrl": "No public address is configured for this site yet.",
	"console.list.appearance": "Appearance",
	"console.list.retry": "Retry setup",
	"console.list.retrying": "Starting…",
	"console.list.delete": "Delete",
	"console.list.deleteConfirm": "Delete \"{name}\"? The site goes offline now. Support can restore it for a limited time.",
	"console.list.deleteFailed": "Could not delete the site.",
	"console.list.suspended": "This site is suspended. Contact support to restore it.",
	"console.list.loadFailed": "Could not load your sites.",
	"console.list.verifyEmail": "Verify your email address to create sites. Check your inbox for the verification link.",
	"console.list.atLimit.one": "You own {owned} of {max} sites. That is the limit.",
	"console.list.atLimit.other": "You own {owned} of {max} sites. That is the limit.",
	"console.list.create": "Create site",
	"console.list.empty": "You have no sites yet.",
	"console.wizard.title": "Create a site",
	"console.wizard.verifyEmail": "Verify your email address before creating a site.",
	"console.wizard.backToSites": "Back to my sites",
	"console.wizard.theme": "Theme",
	"console.wizard.preview": "Preview ↗",
	"console.wizard.name": "Site name",
	"console.wizard.address": "Address",
	"console.wizard.submit": "Create site",
	"console.wizard.cancel": "Cancel",
	"console.wizard.checking": "Checking…",
	"console.wizard.available": "Available.",
	"console.wizard.unavailable": "Not available.",
	"console.wizard.createFailed": "Could not create the site (HTTP {status}).",
	"console.progress.title": "Setting up {name}…",
	"console.progress.duration": "This takes about half a minute.",
	"console.progress.step.queued": "Waiting for a free slot…",
	"console.progress.step.tables": "Creating your site…",
	"console.progress.step.content": "Adding starter content…",
	"console.progress.step.identity": "Setting up your account…",
	"console.progress.slow": "Still working. You can leave this page and check My sites.",
	"console.progress.ready": "{name} is ready",
	"console.progress.mySites": "My sites",
	"console.progress.failed": "Setup did not finish",
	"console.progress.retry": "Go to my sites to retry",
	"console.appearance.forbidden": "You cannot change this site’s appearance.",
	"console.appearance.title": "Appearance · {name}",
	"console.appearance.intro": "Switching keeps all of your content. Anything the new theme does not show is hidden, and comes back if you switch back.",
	"console.appearance.current": "{name} (current)",
	"console.appearance.adds": "Adds: {list}",
	"console.appearance.hides": "Hides: {list}",
	"console.appearance.sample": "Add sample content for any new sections",
	"console.appearance.submit": "Switch theme",
	"console.appearance.back": "Back",
	"console.appearance.switching": "Switching…",
	"console.appearance.failed": "Could not switch.",
	"console.appearance.slow": "This is taking longer than expected. Check back in a minute.",

	// ---- account page, "Sites" tab (auth-ui.ts) ----
	"account.tab": "My sites",
	"account.plan.free": "Free",
	"account.look.label": "Look",
	"account.look.current": "Current",
	"account.look.adds": "Adds {list}",
	"account.look.hides": "hides {list}",
	"account.look.preview": "Preview ↗",
	"account.step.queued": "Lots of people are building right now. You are next…",
	"account.step.tables": "Creating your site…",
	"account.step.content": "Adding your starter pages…",
	"account.step.identity": "Setting up your account…",
	"account.wizard.checking": "Checking…",
	"account.wizard.free": "{address} is free",
	"account.wizard.taken": "That address is taken. Try another.",
	"account.wizard.verifyEmail": "Please confirm your email address first. Then you can create your site.",
	"account.wizard.limit.one": "Your plan includes {max} site, and you have {owned}.",
	"account.wizard.limit.other": "Your plan includes {max} sites, and you have {owned}.",
	"account.wizard.failedTitle": "That did not finish",
	"account.wizard.failedText": "Nothing is lost. Go to your sites and press Try again.",
	"account.wizard.goToSites": "Go to my sites",
	"account.wizard.liveTitle": "Your site is live",
	"account.wizard.edit": "Edit my site",
	"account.wizard.view": "View my site",
	"account.wizard.getStarted": "Get started",
	"account.wizard.checklistItem": "{label} →",
	"account.wizard.backToSites": "Back to my sites",
	"account.wizard.building": "Building {name}…",
	"account.wizard.buildingLabel": "Building your site",
	"account.wizard.almostThere": "Almost there…",
	"account.wizard.step1": "Step 1 of 2",
	"account.wizard.step2": "Step 2 of 2",
	"account.wizard.newSite": "New site",
	"account.wizard.pickTitle": "What do you want to make?",
	"account.wizard.pickText": "Pick a look. You can change it later and your content stays.",
	"account.wizard.continue": "Continue",
	"account.wizard.cancel": "Cancel",
	"account.wizard.back": "Back",
	"account.wizard.createFailed": "Could not create the site (error {status}).",
	"account.wizard.nameTitle": "Name your site",
	"account.wizard.chosenLook": "Look: {name}",
	"account.wizard.nameText": "This is what visitors see. You can change it later.",
	"account.wizard.name": "Site name",
	"account.wizard.namePlaceholder": "My garden notes",
	"account.wizard.address": "Site address",
	"account.wizard.addressOk": "✓ {text}",
	"account.wizard.addressHint": "Letters, numbers and dashes.",
	"account.wizard.submit": "Create my site",
	"account.look.forbidden": "You cannot change this site’s look.",
	"account.look.back": "Back",
	"account.look.changing": "Changing the look… this takes a few seconds.",
	"account.look.failed": "Could not change the look. Try again.",
	"account.look.done": "Done. Your site has its new look. Your content is safe.",
	"account.look.slow": "This is taking longer than usual. Wait a minute, then check your sites. If the look did not change, try again.",
	"account.look.title": "Change the look of {name}",
	"account.look.intro": "Your content stays. Anything the new look does not show is hidden, and comes back if you switch back.",
	"account.look.sample": "Add example content for any new sections",
	"account.look.submit": "Use this look",
	"account.card.paused": "Paused",
	"account.card.settingUp": "Setting up",
	"account.card.needsAttention": "Needs attention",
	"account.card.live": "Live",
	"account.card.pausedText": "This site is paused. Contact support to turn it back on.",
	"account.card.edit": "Edit",
	"account.card.view": "View",
	"account.card.retry": "Try again",
	"account.card.retryFailed": "Could not try again.",
	"account.card.changeLook": "Change look",
	"account.card.delete": "Delete",
	"account.card.deleteConfirm": "Delete \"{name}\"? It goes offline now. Support can bring it back for a limited time.",
	"account.card.deleteFailed": "Could not delete the site.",
	"account.tenant.title": "Manage your sites from your dashboard",
	"account.tenant.text": "This is one of your sites. Your full list of sites, billing and new-site creation live in your hosting dashboard.",
	"account.tenant.link": "Go to my dashboard",
	"account.list.loadFailed": "Could not load your sites. Please reload the page.",
	"account.list.title": "My sites",
	"account.list.usage.one": "{plan} plan — {owned} of {max} site used",
	"account.list.usage.other": "{plan} plan — {owned} of {max} sites used",
	"account.list.upgrade": "Upgrade",
	"account.list.newSite": "New site",
	"account.list.verifyEmail": "Confirm your email address to create a site.",
	"account.list.emptyTitle": "You have no sites yet",
	"account.list.emptyText": "Make one in a minute: pick a look, give it a name, done.",
	"account.list.createFirst": "Create my first site",

	// ---- Fleet (control plane admin page, fleet-blocks.ts / fleet-actions.ts) ----
	"fleet.title": "Fleet",
	"fleet.stats.sites": "Sites",
	"fleet.stats.attention": "Needs attention",
	"fleet.stats.suspended": "Suspended",
	"fleet.stats.deleted": "Deleted, not purged",
	"fleet.stats.users": "Users on sites",
	"fleet.table.empty": "No sites yet.",
	"fleet.table.site": "Site",
	"fleet.table.owner": "Owner",
	"fleet.table.setup": "Setup",
	"fleet.table.state": "State",
	"fleet.table.users": "Users",
	"fleet.table.created": "Created",
	"fleet.table.actions": "Actions",
	"fleet.action.suspend": "Suspend",
	"fleet.action.resume": "Resume",
	"fleet.action.delete": "Delete (kept 14 days)",
	"fleet.action.restore": "Restore",
	"fleet.action.retry": "Retry setup",
	"fleet.action.backup": "Back up now",
	"fleet.action.purge": "Purge",
	"fleet.purge.title": "Purge",
	"fleet.purge.text": "Deleted sites are destroyed automatically after the grace period. Purging now removes the tables, files, backups and organization for good.",
	"fleet.purge.site": "Deleted site",
	"fleet.purge.confirm": "I understand this cannot be undone",
	"fleet.purge.submit": "Purge now",
	"fleet.purge.missing": "Pick a site and tick the box to purge.",
	"fleet.result.controlPlane": "The control plane is not managed here.",
	"fleet.result.refused.suspend": "Cannot suspend \"{slug}\" in its current state.",
	"fleet.result.refused.resume": "Cannot resume \"{slug}\" in its current state.",
	"fleet.result.refused.delete": "Cannot delete \"{slug}\" in its current state.",
	"fleet.result.refused.restore": "Cannot restore \"{slug}\" in its current state.",
	"fleet.result.done.suspend": "{slug}: suspend done.",
	"fleet.result.done.resume": "{slug}: resume done.",
	"fleet.result.done.delete": "{slug}: delete done.",
	"fleet.result.done.restore": "{slug}: restore done.",
	"fleet.result.backedUp": "{slug}: backed up ({kb} KB).",
	"fleet.result.retry": "{slug}: setup restarted. Reload in a minute.",
	"fleet.result.notDeleted": "\"{slug}\" is not deleted.",
	"fleet.result.purge": "{slug}: purge started. It takes about a minute.",
	"fleet.result.unknown": "Unknown action.",

	// ---- sitePage: the "Site" page in each site's own admin (plugin-entry.ts) ----
	"sitePage.title": "Site",
	"sitePage.unmanaged": "This site is not managed by the multi-site platform (site \"{slug}\", {reason}).",
	"sitePage.unmanaged.noOrg": "no matching organization",
	"sitePage.unmanaged.noThemes": "no themes configured",
	"sitePage.unmanaged.noConfig": "no multisite config",
	"sitePage.identity": "{name} ({slug})",
	"sitePage.signup": "Public sign-up is {state}. Change it in Settings, Better Auth, \"Allow new sign-ups\".",
	"sitePage.signup.on": "ON: visitors can create an account",
	"sitePage.signup.off": "OFF: only people you add can sign in",
	"sitePage.appearance.title": "Appearance",
	"sitePage.appearance.text": "Theme: {name}. Switching keeps all of your content; anything the new theme does not show is hidden and comes back if you switch back.",
	"sitePage.appearance.change": "Change theme",
	"sitePage.account.title": "Account",
	"sitePage.account.sites": "My sites",
	"sitePage.account.account": "Account",

	// ---- pages a visitor or a handed-off user may land on (middleware.ts, rules.ts) ----
	"status.notFound": "Not found",
	"status.unavailable.title": "Site unavailable",
	"status.unavailable.heading": "This site is unavailable",
	"status.unavailable.text": "It has been suspended. If this is your site, contact support.",
	"handoff.expired.title": "Link expired",
	"handoff.expired.text": "This sign-in link has expired or was already used. Go back and open the admin again.",
	"demo.label": "Theme demo",
	"demo.text": "This is a demo of the {name} theme.",
	"demo.use": "Use this theme",

	// ---- sign-in links drawn in a theme header (auth-links.ts) ----
	"links.signIn": "Sign in",
	"links.signUp": "Sign up",
	"links.account": "My account",
	"links.admin": "Admin",

	// ---- API error messages shown to the user (rules.ts, console.ts, middleware.ts, abuse.ts) ----
	"api.address.missing": "Choose a name for your site address.",
	"api.address.invalid": "Use 1-40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
	"api.address.reserved": "\"{slug}\" is reserved. Choose another address.",
	"api.address.taken": "That address is taken.",
	"api.create.emailNotVerified": "Verify your email address before creating a site.",
	"api.create.limit.one": "You can own up to {max} site.",
	"api.create.limit.other": "You can own up to {max} sites.",
	"api.create.platformFull": "New sites are paused right now. Please try again later.",
	"api.theme.invalid": "Choose one of the available themes.",
	"api.theme.missing": "Choose a theme.",
	"api.rateLimited": "Too many requests. Try again in a minute.",
	"api.signup.emailDomain": "Please sign up with a permanent email address.",
	"api.security.failed": "Security check failed. Please try again.",
	"api.security.failedWith": "Security check failed: {reason}",
	"api.security.invalidToken": "Invalid token",
	"api.deleteFromSites": "Delete the site from My sites instead.",
	"api.purgeNotDue.one": "Deleted sites are kept {days} day.",
	"api.purgeNotDue.other": "Deleted sites are kept {days} days.",
} as const;

export type MessageKey = keyof typeof en;
/** Keys that come as a `.one` / `.other` pair, without the suffix. */
export type PluralKey = { [K in MessageKey]: K extends `${infer B}.one` ? B : never }[MessageKey];
export type Params = Record<string, string | number>;

/** The catalog in use. A single locale for now. */
const LOCALE = "en";
const catalog: Record<MessageKey, string> = en;
const plural = new Intl.PluralRules(LOCALE);

const fill = (text: string, params: Params | undefined, map: (v: string) => string = (v) => v): string =>
	params ? text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? map(String(params[name])) : m)) : text;

export const escapeHtml = (v: string): string => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The message, with `{name}` placeholders replaced by `params`. An unknown placeholder is left as is. */
export function t(key: MessageKey, params?: Params): string {
	return fill(catalog[key], params);
}

/** The `.one` or `.other` form of `base` for `count` (also available to the message as `{count}`). */
export function tn(base: PluralKey, count: number, params?: Params): string {
	const form = plural.select(count) === "one" ? "one" : "other";
	return t(`${base}.${form}` as MessageKey, { count, ...params });
}

/** `t` for HTML: the message text and every param are escaped. */
export function tHtml(key: MessageKey, params?: Params): string {
	return fill(escapeHtml(catalog[key]), params, escapeHtml);
}

/** Every message whose key starts with `prefix`, for a client script (keeps the rest of the catalog out of the page). */
export function messagesFor(prefix: string): Record<string, string> {
	return Object.fromEntries(Object.entries(catalog).filter(([k]) => k.startsWith(prefix)));
}

/** All message keys (for the self-check). */
export const messageKeys = (): MessageKey[] => Object.keys(catalog) as MessageKey[];
