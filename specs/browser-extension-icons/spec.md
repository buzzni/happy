# Browser Extension Icons Spec

> Created: 2026-08-09 / Status: awaiting plan approval

## Goal

Ship the existing Happy Browser Bridge icon assets with the Chrome extension and
declare them in the extension manifest.

## Requirements

- R1. The manifest declares the supplied 16, 32, 48, and 128 pixel PNG icons
  for the extension and toolbar action.
- R2. Every declared icon file is included in `shipped-files.json`, the sole
  source of truth for CLI packaging.
- R3. The repository ignores local `memory/` and `memory.bak-*` conversation
  mirrors without affecting tracked source files.

## Non-goals

- Change extension permissions, browser bridge behavior, or icon design.
- Update the parent `aplus-dev-studio` submodule pointer in this pull request.
