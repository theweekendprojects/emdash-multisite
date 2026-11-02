# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) (pre-1.0: minor versions may
contain breaking changes).

## [Unreleased]

### Fixed
- Self-checks aligned with EmDash 1.4.0: dropped the dead taxonomy holder cache keys
  (`emdash:taxonomy-defs@2`, `emdash:taxonomy-names`, now the `:swr` variants), and the
  edge-cache settings-memo self-check now uses the current `emdash:site-settings:swr` key.
  No runtime change.

## [0.8.0] - 2026-11-02

### Added
- **Host-aware edge cache.** Cloudflare Workers Cache keys entries by path, not hostname,
  and one Worker serves every tenant; a cached inner entrypoint folds the host into the
  cache key, with a default-deny response guard so only clean anonymous 200s are stored.
  Tagged `site:<slug>` for per-site purging. (`edge-cache` export + `scheduled`.)
- **Purge on edit.** Public content changes purge the site's cache immediately via the
  `site:<slug>` tag, instead of waiting for the TTL (1 hour + 1 day stale-while-revalidate).
- Pre-warming of a new site's cold public routes (including `/sitemap.xml`) at provisioning.
- SMTP provider config is inherited into tenants at provisioning.

### Changed
- Cache patcher classifies the EmDash 1.4.0 cache keys and the globalThis-cast holder shape.
- `site:url` and `emdash:site_title` are written at provisioning so plugins read them.

### Fixed
- Turnstile sign-up token read from the `x-captcha-response` header; removed a redundant
  verify in `guardSignup`.
- Cache-filling renders no longer serve a stale per-isolate site-settings memo after a purge.
- `/llms.txt` is themed instead of left unserved.

## [0.7.0] - 2026-11-01

First open-source release (MIT), published to npm as `emdash-multisite`.

### Added
- Published to npm with a `bin` scaffolder (`npx emdash-multisite setup`), copy-paste
  `templates/` (worker + wrangler + astro config snippets), `SETUP.md`, and an
  open-source `README.md`.
- Plan-driven per-site limits: `resolveLimits` prefers organization-metadata entitlements
  over the built-in `PLAN_LIMITS` map.
- Abuse controls: per-IP site-creation cap and a Turnstile sign-up check.
- Public search hides members-only and premium entries.

### Fixed
- Site owner is granted the Better Auth `admin` role on their new site.
- SQL rewrite round-trips the `$site` suffix through stored DDL and introspection params, so
  media-usage activation completes on every tenant (previously failed on non-primary sites).
- The "My sites" account tab shows a tenant notice instead of bouncing on a tenant host.

[Unreleased]: https://github.com/theweekendprojects/emdash-multisite/compare/v0.8.0...HEAD
[0.8.0]: https://github.com/theweekendprojects/emdash-multisite/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/theweekendprojects/emdash-multisite/releases/tag/v0.7.0
