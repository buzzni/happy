# Agent Workflow

## Sync To Main

When the user says `sync to main` or `synt to main`, they mean:

1. Fetch `origin/main`.
2. Rebase the current branch on `origin/main`.
3. Push the current HEAD directly to `main` with a normal push, for example:
   `git push origin HEAD:main`

Do not force push for this workflow.

## Happy CLI Local Install / Publish

`packages/happy-cli` imports `@slopus/happy-wire` at runtime, while the source
workspace uses `file:../happy-wire`. Do not use `npm install -g .` or `npm link`
from `packages/happy-cli` for daemon runtime installs; that can recreate
`ERR_MODULE_NOT_FOUND: Cannot find package '@slopus/happy-wire'`.

Use:

```bash
corepack pnpm -C packages/happy-cli run cli:install
```

Publish only a package prepared by `packages/happy-cli/scripts/prepare-publish-package.cjs`
and verified with `packages/happy-cli/scripts/guard-publish-artifact.cjs --install-smoke`.

## Happy CLI Release Publisher (CRITICAL)

GitHub Actions is the **only** publisher for `@buzzni/happy-cli`.

1. Bump `packages/happy-cli/package.json`, validate the release change, and merge it
   to `main`.
2. Create and push exactly one matching `happy-cli-v<version>` tag.
3. Let `Publish @buzzni/happy-cli` build, guard, publish, and verify the package.

Never run `npm publish`, `pnpm publish`, or `yarn publish` locally for this package,
including from a prepared publish directory. A local publish followed by the release-tag
push makes CI publish the immutable npm version a second time; npm rejects that attempt
with E403 and the workflow is correctly marked failed. Do not re-run such a failed job:
confirm the registry version, then use a new version only if a corrected release is needed.

`docs/happy-cli-release.md` is the release runbook and source of truth for this policy.

Every external Happy CLI release mutation requires the user's explicit approval
immediately before it is performed. Planning approval or approval to implement
release hardening does not authorize tag pushes, `npm publish`, npm dist-tag
changes, or npm deprecation changes. Present the exact version and external
commands/actions, wait for approval, and only then perform the approved subset.
