# Ordinary Chat schedules plan

Review follow-up (2026-10-15, 2f9e69c): parse the daemon resume command's
`--model` in the existing Codex command handler and pass it to the runner.
Explicit command model takes precedence over the one-shot environment seed,
then the saved reconnect pin; always consume the environment seed so children
cannot inherit it. Reproduce this through the real command/runner boundary
with differing launch and saved models, for both unused and existing provider
threads, then run related tests and CLI type/build checks. This is an internal
Core session-launch correction with no wire/schema/dependency changes. Revert
the fix commit for rollback. Publication and PC runtime replacement are outside
the initial local review-fix request. The user's subsequent request authorizes
PR/CI/main integration, official publication, this PC's runtime application and
live scheduled validation. Prepare .328 and its artifact; obtain exact tag-push
approval per AGENTS immediately before publication. Prove a different explicit
daemon resume model, then a real clock-based QA reservation in that same Chat;
pause QA afterward and preserve unrelated sessions/credentials. Retain the old
runtime directory for rollback without changing keys or machine registration.

Review follow-up (2026-10-14): preserve the v3 script revision contract during Chat lifecycle transitions and keep legacy runtime cancellation targets until stop acknowledgement. Use existing state and APIs; no DB or wire schema changes. Reproduce the HTTP list and second-stop failures, validate pause/restore/resume and restart-safe runtime persistence, then update Happy #812 and Studio's pin. Revert these fix commits for rollback; preserve encrypted definitions/history.

Core owns the run, session and encrypted message consistency. payloadVersion 4 seals `conversation.sessionId`; 3 remains script-only. Keep protocolVersion unchanged because script readiness uses its 4/5 gate. Publish encrypted machine metadata `automationSupport.conversation: true` and explicitly negotiate sync `payloadVersions: [1, 4]`. Old sync callers receive tombstones for v4. Resync pre-capability disk caches once.

1. Wire mode and version validation, capability negotiation and cache recovery.
2. Current Chat authorization through Studio; tracked-session keys/directory and existing resume fence.
3. Atomic claim/generation/key/permission/sequence validation and run-localId delivery in existing Prisma transaction; emit the normal encrypted message update.
4. Related tests, production CLI build, server types and contract smoke; record deployment limitations.

The existing provider retains ordinary owner permissions and AI settings. Reject per-run restrictive connector policies instead of claiming they were applied to a live session. No replacement session on failure. Roll back by pausing v4 definitions and reverting versions, preserving all ordinary messages. Do not convert v4 into v1. Deploy Happy server, Studio, CLI, then Desktop; tags/install/release/push require separate authorization.

## Lifecycle implementation

An owner+CAL1-protected impact/lifecycle API persists the internal Chat state in existing Project.config. Serializable updates fence definitions, cancel claims/queued scripts and request active script cancellation. Ordinary project config updates preserve this fence. Deleted tombstones carry only encrypted execution targets; CLI persists pending cancellations and validates tracked keys/canonical directory before verified stop. Older caches resync once via chatLifecycleSync. CAL1 is a separate server-only wire export with Chat/action/bearer-hash binding and 30-second TTL. Reuse cloud SCRIPT_AUTOMATION_ADMISSION_SECRET or standalone HANDY_MASTER_SECRET, never expose either to clients. Missing authority fails closed. Roll back versions with definitions paused/deleted and history preserved.
