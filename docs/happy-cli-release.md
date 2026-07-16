# Happy CLI Release

This document covers the A+ fork release path for `@namsangboy/happy-cli`.

## Fork Scope

The A+ Happy CLI release line is maintained for Buzzni/A+ service integration.
Do not treat A+ release work as an upstream contribution path to
`slopus/happy` `main`.

When updating from upstream, merge released upstream tags into the A+ fork and
validate the A+ service surfaces. Do not open or plan a reverse PR back to
upstream `main` unless that is explicitly requested as separate work.

## Version Bump

1. Update `packages/happy-cli/package.json` to the next `*-aplus.*` version.
2. Run the normal build and tests from the workspace.
3. Create a tag that exactly matches the package version: `happy-cli-v<version>`.
4. Push the tag. The `Publish @namsangboy/happy-cli` workflow verifies that the tag and package version match before publishing.

## Publish Artifact Rule

Do not publish directly from the raw pnpm workspace package.

The source package can use local workspace wiring during development, but the npm registry artifact must not expose local-only dependency protocols. In particular:

- `dependencies.@slopus/happy-wire` in the publish artifact must be a registry version, not `workspace:*` or `file:../happy-wire`.
- `@slopus/happy-wire` must be bundled into the CLI artifact until the A+ wire package changes are published independently.
- The bundled dependency closure currently includes `@slopus/happy-wire`, `@paralleldrive/cuid2`, `@noble/hashes`, and `zod`.

The release workflow therefore does this after build:

```sh
REPO="$(pwd)"
node packages/happy-cli/scripts/prepare-publish-package.cjs --out "$RUNNER_TEMP/happy-cli-publish"
cd "$RUNNER_TEMP/happy-cli-publish"
mkdir -p "$RUNNER_TEMP/happy-cli-pack"
npm pack --ignore-scripts --pack-destination "$RUNNER_TEMP/happy-cli-pack"
PUBLISH_TGZ="$(ls "$RUNNER_TEMP"/happy-cli-pack/*.tgz)"
node "$REPO/packages/happy-cli/scripts/guard-publish-artifact.cjs" "$PUBLISH_TGZ" --install-smoke
npm publish "$PUBLISH_TGZ" --access public --tag latest --ignore-scripts
VERSION="$(node -p 'require("./package.json").version')"
TARBALL_URL="$(npm view "@namsangboy/happy-cli@$VERSION" dist.tarball)"
until curl -fsI "$TARBALL_URL" >/dev/null; do
  echo "waiting for npm tarball propagation: $TARBALL_URL"
  sleep 30
done
npm install -g "@namsangboy/happy-cli@$VERSION" --ignore-scripts --prefer-online
HAPPY_HOME_DIR="$(mktemp -d)" happy daemon status
```

The final `npm publish` takes the guarded `.tgz` path, so the registry receives the exact bytes the guard verified. Never publish in any form that re-packs the package:

- `npm publish "$RUNNER_TEMP/happy-cli-publish"` (directory path) re-packed without the bundled dependency set — this shipped `1.1.10-aplus.36` broken.
- `pnpm publish` (and `yarn publish`) do not implement `bundledDependencies` at all; they silently drop the bundled `node_modules` while the metadata still declares them — this shipped `1.1.10-aplus.44` broken.

`prepublishOnly` in both the source and the prepared package now runs `scripts/assert-publish-tool.cjs`, which rejects non-npm publishers, and the published artifact's `postinstall` runs `scripts/verify-bundled-deps.cjs`, which fails a registry install immediately when the bundled files are missing instead of crashing later with `ERR_MODULE_NOT_FOUND`.

The command includes `--tag latest` because `*-aplus.*` versions are semver prereleases and npm requires an explicit dist-tag for those publishes.

After publish, always install the exact version from the npm registry and run `happy daemon status`. This verifies that the registry metadata, registry tarball, bundled dependency files, and CLI entrypoint all work outside the monorepo.

## npm Tarball Propagation

`npm publish` can print `+ @namsangboy/happy-cli@<version>` before every registry edge can serve the tarball blob. During that window, `npm view @namsangboy/happy-cli@<version>` and the `latest` dist-tag can already show the new version, while the package tarball URL still returns HTTP 404.

This is an npm registry/CDN propagation delay between package metadata and the tarball object, not a CLI runtime failure. Do not immediately republish just because the first registry install gets a 404. Treat publish as complete only after the tarball URL returns 200 and the registry install smoke passes.

Use this wait loop after every publish:

```sh
VERSION="$(node -p 'require("./package.json").version')"
TARBALL_URL="$(npm view "@namsangboy/happy-cli@$VERSION" dist.tarball)"
until curl -fsI "$TARBALL_URL" >/dev/null; do
  echo "waiting for npm tarball propagation: $TARBALL_URL"
  sleep 30
done
npm install -g "@namsangboy/happy-cli@$VERSION" --ignore-scripts --prefer-online
HAPPY_HOME_DIR="$(mktemp -d)" happy daemon status
```

Observed on `1.1.10-aplus.37` and `1.1.10-aplus.38`: metadata appeared first, tarball URL returned 404 for a few minutes, then the same URL became 200. The fastest safe release path is to start this polling immediately after `npm publish` succeeds, not to retry publish.

## GitHub Repository Targeting

The local git remote can point at `buzzni/happy` while GitHub CLI may still infer `slopus/happy` from repository metadata. Always pass `--repo buzzni/happy` for Happy PR commands:

```sh
gh pr create --repo buzzni/happy --base main --head <branch> --title "<title>" --body-file <body-file>
gh pr view <number> --repo buzzni/happy --json state,mergeCommit,url
gh pr checks <number> --repo buzzni/happy --watch=false
gh pr merge <number> --repo buzzni/happy --squash --delete-branch
```

Do not rely on `gh repo view` or the default inferred repository for this fork.

## Completion Checklist

Every Happy CLI publish is complete only after all of these are true:

1. The release change is merged into `buzzni/happy` `main`.
2. `@namsangboy/happy-cli@<version>` is published and `latest` points to that version.
3. The npm tarball URL returns 200.
4. A fresh registry install runs `happy daemon status` successfully.
5. `buzzni/aplus-dev-studio` updates `vendor/happy` to the merged `buzzni/happy` `main` commit.
6. The root repo `vendor/happy` pointer PR is merged into `buzzni/aplus-dev-studio` `main`.

When the root repo has unrelated local work, use a temporary root worktree from `origin/main` for the pointer PR so release cleanup does not mix with local changes.

## Why 1.1.10-aplus.36 Failed

`1.1.10-aplus.36` was prepared from the clean publish directory but was manually published with:

```sh
npm publish "$RUNNER_TEMP/happy-cli-publish" --access public --tag latest --ignore-scripts
```

That directory-path publish produced registry metadata that still declared bundled dependencies, including `@slopus/happy-wire`, `zod`, `@paralleldrive/cuid2`, and `@noble/hashes`, but the published tarball did not contain the bundled `node_modules` entries. npm then trusted the `bundledDependencies` metadata and did not install those packages from the registry. A fresh global install failed before daemon code ran:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@slopus/happy-wire' imported from .../@namsangboy/happy-cli/dist/index.mjs
```

The fix is to pack from inside the prepared directory, guard the resulting `.tgz`, publish from inside that same prepared directory, and then run a post-publish registry install smoke. The install smoke must also execute the installed `happy` entrypoint so missing runtime imports fail before release completion.

## Why 1.1.10-aplus.44 Failed

`1.1.10-aplus.44` was prepared correctly but published manually outside the tag workflow (the registry entry has no provenance attestation, unlike `1.1.10-aplus.43`). The publish tool re-packed the prepared directory without honoring `bundledDependencies` — the tarball had 64 files instead of ~1100 and contained no `node_modules` — while the metadata still declared the bundled set. Fresh installs failed exactly like `1.1.10-aplus.36`:

```text
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@slopus/happy-wire' imported from .../@namsangboy/happy-cli/dist/index.mjs
```

This is the failure mode of `pnpm publish` (pnpm does not implement `bundledDependencies`). The per-artifact guard did not help because it packs with `npm pack` internally — the guard's own tarball was fine; the publisher's re-packed tarball was not. Three defenses were added after this incident:

1. The workflow publishes the guarded `.tgz` path itself, so no re-pack can happen between guard and publish.
2. `scripts/assert-publish-tool.cjs` runs from `prepublishOnly` and rejects pnpm/yarn publishers outright.
3. `scripts/verify-bundled-deps.cjs` runs from the published artifact's `postinstall` and fails the install with an actionable message when bundled files are missing.

In the field, a machine with the broken version installed can be repaired without waiting for a republish:

```sh
cd "$(npm root -g)/@namsangboy/happy-cli"
npm install --no-save --no-package-lock '@slopus/happy-wire@<version>' '@paralleldrive/cuid2@^2.2.2' '@noble/hashes@^2.0.1' 'zod@^4.0.0'
happy daemon stop && happy daemon start
```

## Why 1.1.8-aplus.22 Failed

`1.1.8-aplus.22` was published with this dependency metadata:

```json
"@slopus/happy-wire": "workspace:*"
```

Local builds and tests did not catch it because pnpm resolves `workspace:*` to the local `packages/happy-wire` package. A registry install happens outside the monorepo, so npm reads the published metadata as-is and fails with:

```text
EUNSUPPORTEDPROTOCOL Unsupported URL Type "workspace:": workspace:*
```

This was introduced when upstream pnpm workspace metadata was merged back into the A+ fork. The previous A+ release line used a registry version for `@slopus/happy-wire`, so the issue only appeared in the new version.

## Guard Requirements

`scripts/guard-publish-artifact.cjs` checks the packed npm artifact, not just source files. It fails when:

- any dependency metadata contains `workspace:` or `file:`;
- `@slopus/happy-wire` is missing or points to a local-only protocol;
- the tarball contains pnpm workspace paths such as `node_modules/.pnpm` or `../`;
- required bundled files are missing;
- the optional global install smoke test cannot install the tarball;
- the optional global install smoke test cannot execute the installed `happy daemon status` entrypoint.

Do not remove this guard from the publish workflow.

## Should We Use pnpm Pack or pnpm Publish?

`pnpm pack` and `pnpm publish` can rewrite `workspace:` dependencies for normal pnpm monorepo packages, so they are useful when every workspace dependency is independently publishable with a correct version.

That is not enough for this fork right now. The CLI currently needs the local A+ `@slopus/happy-wire` build bundled into the CLI package, and direct packing from the pnpm workspace can still expose workspace-shaped paths or incomplete bundled dependency content if the artifact is not prepared cleanly first.

Current rule: build with pnpm, prepare a clean publish directory, pack a `.tgz` from inside that directory, guard that `.tgz`, publish from inside the prepared directory, then verify the exact published version by installing from the npm registry.

If `@slopus/happy-wire` or an A+ scoped replacement is later published independently with its own bumped version, we can revisit this and simplify the release path to versioned workspace dependencies plus `pnpm publish`/`pnpm pack`.
