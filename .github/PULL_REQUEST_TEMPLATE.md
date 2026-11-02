<!-- Thanks for contributing! Read CONTRIBUTING.md if you haven't. -->

## What does this change?

<!-- One or two sentences. Link the issue it closes: "Closes #123". -->

## Why?

<!-- The problem this solves. -->

## How did you verify it?

<!-- Which self-checks did you run? Paste the result. -->

- [ ] `node --no-warnings scripts/orgs.selfcheck.ts`
- [ ] `node --no-warnings scripts/edge-cache.selfcheck.ts`
- [ ] `node --no-warnings scripts/caches.selfcheck.ts <path-to-node_modules>` (if touching caches / the Vite patch)
- [ ] `node --no-warnings scripts/selfcheck.ts` (if touching the DB wrapper / rewrite)
- [ ] `tsc -p tsconfig.json` is clean

## Checklist

- [ ] This does not weaken tenant isolation (data, cache, auth).
- [ ] Added or updated a self-check that fails without this change (for non-trivial logic).
- [ ] Updated docs: `README.md` (user-facing), `AGENTS.md` (new gotcha), `CHANGELOG.md` under `## [Unreleased]`.
- [ ] Commit messages follow Conventional Commits.
