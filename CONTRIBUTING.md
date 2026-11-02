# Contributing to emdash-multisite

Thanks for your interest in improving emdash-multisite. This is the multi-tenant engine
for [EmDash](https://github.com/emdash-cms/emdash): many sites from one Cloudflare Worker
and one D1 database. Contributions of all sizes are welcome — bug reports, docs, tests,
and code.

Please read this file and [`AGENTS.md`](./AGENTS.md) before opening a pull request.
`AGENTS.md` is the architecture and the land mines; this file is the workflow.

## Ground rules

- Be kind. See [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).
- Found a security issue (especially a cross-tenant data leak)? **Do not open a public
  issue** — follow [`SECURITY.md`](./SECURITY.md).
- Discuss large changes in an issue first. A new mechanism, a new config field, or a
  change to how sites resolve is worth a short design discussion before code.

## Development setup

Requirements:

- **Node ≥ 22.18** (the tooling and self-checks run native TypeScript). A lower default
  Node will break the scripts; use a version manager (e.g. `nvm use 22`).
- **pnpm** (the EmDash templates use it).

```bash
git clone https://github.com/theweekendprojects/emdash-multisite
cd emdash-multisite
pnpm install
```

This package ships **TypeScript source, no `dist`** — by design. The cache patch and the
database wrapper must run through a consuming app's Vite/Astro build, so there is nothing
to compile here for distribution. The consuming site compiles the source.

## Verifying a change (always do this)

Run the self-checks with Node ≥ 22.18 before you push. They are the project's test suite:

```bash
# Slug validation, org-response parsing, limits, reconcile, theme routing (no deps)
node --no-warnings scripts/orgs.selfcheck.ts

# The edge-cache pure rules + purger behaviour
node --no-warnings scripts/edge-cache.selfcheck.ts

# The cache tripwire — scans an installed emdash and fails if any cache key is
# unclassified. Point it at a consuming site's node_modules.
node --no-warnings scripts/caches.selfcheck.ts /path/to/a-site/node_modules

# The migration oracle — runs real EmDash migrations + repositories through the
# wrapper and asserts per-site isolation. Run from (or against) a site that has
# `emdash` installed.
node --no-warnings scripts/selfcheck.ts
```

Type-check must be clean:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
```

The real gate for a cache change is: the build does not throw, the cache tripwire passes,
and a two-site title test stays isolated under concurrency (see the companion host repos).

## How the test suite works (important)

There is no test framework and no fixtures — each `scripts/*.selfcheck.ts` is a plain Node
script that asserts with `eq(...)` and exits non-zero on failure. When you add non-trivial
logic, add or extend the matching self-check. Keep pure decision logic in `src/rules.ts` so
it runs under plain Node without the virtual EmDash modules.

## Upgrading EmDash

The cache patch rewrites EmDash's own compiled code at build time, so an EmDash upgrade can
move it. The build **fails loudly** when that happens — that is the safety net, not a bug.
If you bump the `emdash` peer range or a reviewer asks you to verify against a new EmDash:

1. Install the new `emdash` in a consuming site.
2. Run `scripts/caches.selfcheck.ts` against its `node_modules`.
3. If it fails, it names the cache key that changed. Classify it in `src/vite.ts`
   (`HOLDER_KEYS` / `SLOT_KEYS` / `SITE_INDEPENDENT_KEYS`) or fix the shape regex.
4. Re-run until green. Never silence the tripwire — it refuses to ship a cache that would
   leak across tenants.

## Pull request flow

1. Fork, branch off `main`.
2. Make the change. Keep it focused — one concern per PR.
3. Run the self-checks + `tsc`. All must be green.
4. Update docs: `README.md` for user-facing behaviour, `AGENTS.md` for a new gotcha, and
   `CHANGELOG.md` under an `## [Unreleased]` heading.
5. Open the PR. Fill in the template: what changed, why, and how you verified it.

### Commit and branch conventions

- The project uses a single `main` branch. Open PRs from a fork or a topic branch.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`. Scope is optional
  (`fix(rewrite): ...`).

## What makes a change easy to accept

- It has a self-check that fails without it.
- It does not weaken tenant isolation. Isolation is the whole product.
- It updates the docs it affects.
- It is the smallest change that solves the problem.

## Releasing (maintainers)

```bash
npm version <patch|minor|major>   # bumps package.json + tags
npm publish                       # requires npm login / a publish token
git push && git push --tags
```

Move `## [Unreleased]` entries in `CHANGELOG.md` under the new version heading first.

Thanks for contributing.
