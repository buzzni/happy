# Findings and verification

PR #433 fixes the 15-minute reschedule after eventless AgentTask dispatch and raises the machine-wide worker cap to eight. It still starts only one eventless task per daemon tick. With a continuously nonempty queue and no exits, that takes eight ticks to fill eight slots.

The additional change requeues a successful AgentTask launch inside the existing work queue and includes eventless dispatch in the three-attempt tick budget. Discovery-only polls do not consume that budget. Tests now require 3, 6, then 8 running workers across three ticks, no ninth claim at capacity, replacement after a worker exits, and termination of immediate draining on empty/error dispatch. Single-task fixtures return their task only once instead of simulating an unlimited queue of the same task.

## Local evidence

The inspected daemon state reported CLI 1.1.10-aplus.210, so the PR was not yet running there. Its runtime snapshot listed two tracked GitHub sessions belonging to different automations; this is a snapshot, not independently verified process liveness. Existing server claim code in the enclosing project filters writer tasks when resource leases are occupied but allows read-only reviews across workflows. The logs also contain artifact-invalid and resource-unavailable dispatch outcomes, which concurrency scheduling cannot fix. The exact user-reported project was not identified.

Eight is a shared machine limit, not eight slots reserved for every project. A full queue can fill in three ticks after this change, subject to available machine capacity, server eligibility, and launch latency. Agent processing speed and completion latency were not benchmarked. No daemon restart, installation, release, or production concurrency verification was performed.

## Validation

- Red: original PR fails the three-launch first-tick expectation (actual one).
- Automation unit tests: 454 passed, 7 skipped across 32 suites (30 passed, 2 skipped).
- Executor tests: 107 passed.
- Capacity mutation: allowing a ninth worker causes the strengthened tests to fail (expected eight, actual nine); original guard restored.
- Test harness uses this checkout's happy-wire source with the existing installed dependencies; global build/integration setup was not invoked.
- Full CLI typecheck uses a temporary configuration resolving this checkout's happy-wire sources; passed with no diagnostics.

Work was isolated from the unrelated vendor/happy working changes. Product code changes are limited to the executor and its regression tests.
