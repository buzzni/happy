# Browser Extension Icons Plan

> Basis: [spec.md](./spec.md)

## Phase 1 — Scope and plan (Done)

- Confirm the existing dirty assets and manifest/package-list changes are the
  complete intended diff.
- Verification: all changed files map directly to R1–R3.

## Phase 2 — Validate the packaged extension (Done)

- Validate the manifest references and package output with the extension's
  existing packaging/test commands.
- Verification: 159 extension tests passed; packaged archive contains all four
  icon files at their declared 16, 32, 48, and 128 pixel dimensions.

## Phase 3 — Deliver the isolated pull request (Done)

- Create a branch from current `origin/main`, commit only the icon, manifest,
  shipped-files, `.gitignore`, and this spec bundle.
- Push and open a PR against `main`.
- Verification: PR diff contains no CSR-smoke or parent-repository changes.
