# Security Policy

emdash-multisite runs many independent tenant sites from one Worker and one database. The
single most important property it provides is **tenant isolation**: one site must never be
able to read or write another site's data, settings, or users. A vulnerability that breaks
that is the most serious kind of bug this project can have.

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.** Public disclosure
before a fix is available puts every deployment at risk.

Instead, report privately through one of:

- GitHub's **[Private vulnerability reporting](https://github.com/theweekendprojects/emdash-multisite/security/advisories/new)**
  (Security tab → "Report a vulnerability"). This is the preferred channel.
- If that is unavailable, email the maintainers (see the contact in the GitHub org profile).

Please include:

- A description of the issue and its impact (especially whether it crosses tenant
  boundaries).
- Steps to reproduce, or a proof-of-concept, if you have one.
- The versions of `emdash-multisite`, `emdash`, and the relevant `@emdash-cms/*` packages.

We will acknowledge your report, keep you updated on the fix, and credit you in the release
notes unless you prefer to stay anonymous.

## What counts as a security issue here

High priority:

- **Cross-tenant data access** — any way one site reads or writes another site's tables,
  cached data, media, or sessions.
- A cache that is not made per-site and leaks one tenant's content/settings into another.
- SQL that escapes the per-site table rewrite (e.g. a query that hits the primary site's
  tables from a tenant request).
- A control-plane secret becoming readable by a tenant admin (see the provisioning note in
  `AGENTS.md`).
- Authentication or authorization bypass between the control plane and tenants, or between
  tenants.

Also in scope:

- Provisioning or purge flows that can be abused to create or destroy sites.
- Denial of service through the site-creation or cache-purge paths.

## Supported versions

This project is pre-1.0. Security fixes are released on the latest published version. Please
upgrade to the latest release before reporting, if you can, to confirm the issue still
exists.

## Operator responsibilities

Some protections depend on how you deploy:

- Keep platform secrets as Worker secrets/env, **not** saved in the control-plane admin
  settings (provisioning copies admin settings into every tenant). See `AGENTS.md`.
- Do not enable the EmDash object cache or treat R2 as per-site until per-site key
  prefixing is in place.
- Run the cache tripwire on every EmDash upgrade before deploying.

These are documented in `README.md` ("Limits & gotchas") and `AGENTS.md`.
