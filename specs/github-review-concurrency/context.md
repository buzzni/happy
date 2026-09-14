# Findings and verification

The executor drains eligible AgentTask reviews within each daemon tick instead of waiting 15 minutes after each launch. Per the updated user requirement, the tick budget is four and the shared machine-wide worker limit is fifteen. With eligible queued tasks, available slots and no exits, tests require 4, 8, 12, then 15 active workers across four ticks. A sixteenth claim is blocked; a finished worker frees a slot.

Eventless AgentTask dispatch and local GitHub event work share the tick budget. Discovery-only polls do not consume it. Empty/error dispatch stops immediate draining; empty queues retain the normal 15-minute cadence. Writer resource locking remains unchanged. A cross-automation regression offers five automations and verifies only four launches, leaving the fifth pending. The notification regression also verifies four-event draining and remaining queue progress.

## Validation

- Red: four regressions failed against the old 3-per-tick / 8-per-machine limits; first tick expected four starts and observed three.
- Automation tests: 454 passed, 7 skipped (30 suites passed, 2 skipped).
- Full CLI typecheck: passed with no diagnostics.
- Mutation checks: permitting five starts or sixteen workers makes the slot-ramp regressions fail; required limits restored.
- Validation used existing dependencies with a temporary unit-test config and typecheck config resolving this checkout's happy-wire sources. Global build/integration setup and release packaging were not run for this follow-up.

## Runtime limits

The earlier inspected daemon state reported CLI 1.1.10-aplus.210. Installation, daemon restart, release and production concurrency verification have not been performed. Fifteen slots are shared across projects; actual concurrency also depends on server eligibility and launch latency. End-to-end review speed and machine resource use at fifteen workers have not been measured.

Work is isolated from unrelated vendor/happy working changes. Code changes are limited to the executor and its tests.

## Release follow-up

The already-published .211 tag predates #433 and still has limits 3/6. Prepare .212 from main containing #433 to ship the requested 4/15 limits. The user requested npm publication if needed. Publication uses the GitHub Actions tag workflow, never a local publish command.

Candidate .212 validation passed: clean frozen-lockfile dependency installation, wire and CLI builds/typechecks, automation tests (454 passed / 7 skipped), package preparation, npm pack, and artifact guard with install smoke. Existing pkgroll bin-path/empty-chunk warnings remain. Runtime installation paths are read-only in this execution environment; host daemon upgrade is not yet performed.
