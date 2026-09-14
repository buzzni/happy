# Plan

User requested four starts per tick and fifteen concurrent workers per machine.

1. Update limit regressions and confirm failure — Done.
2. Change the two executor limits and run regression tests/typecheck — Done.
3. Update validation notes and deliver through PR #433 — Done.

## Release .212

1. Validate candidate package from main containing #433 — Done.
2. Merge version PR and publish matching tag through GitHub Actions.
3. Verify npm metadata, tarball, registry install and runtime availability.
