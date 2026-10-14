---
feature: ordinary-chat-schedules
status: release-preparation
updated: 2026-10-14
---

# Ordinary Chat schedules context

## 2026-10-14 official CLI release and live acceptance

Release PR #814 macOS CI exposed two existing immediate PID-disappearance assertions in separate attempts: sealedSpawnEnv timeout, then checkpoint writer descendant cleanup. Neither runtime/test changed since .322; each attempt otherwise passed 10,953 tests. The tests now poll up to 2 seconds for ESRCH, allowing OS reaping after group shutdown while rejecting permission errors and surviving processes. Product shutdown logic is unchanged. Both affected files (12 tests) and CLI typecheck pass locally; a fresh CI run is required before merging/tagging.

The user explicitly requested publishing the supporting CLI, applying it to this PC, and verifying actual scheduled execution and ordinary Chat accumulation on the web. Prepared @buzzni/happy-cli 1.1.10-aplus.323 from main ec9c0bae, which includes Happy #812/#813 and all reviewed fixes. The currently published .322 lacks the conversation runner. GitHub Actions remains the sole publisher; no local publish or independent registry tag/deprecation changes are allowed. Candidate production build and 173 relevant automation/version/package tests passed. Prepared tarball guard with fresh install smoke passed after correcting this worktree's stale ignored Saycode dependency symlink from 0.8.1 to the declared 0.9.4; other checkouts and running installations were untouched. Studio product 7baa34792 includes vendor 8400a129 and its production deployment succeeded. Keep existing PC sessions, credentials, reservation history and ordinary messages intact. Desktop must consume the exact successful release identity, and real provider/web acceptance is separate from package verification.

## 2026-10-14 AgentTask lifecycle review fixes

Reproduced a script list HTTP 409 after Chat archive/restore and a legacy v1 cancellation whose second stop was never attempted. Script v3 now preserves its existing definition revision during lifecycle pause/delete and stays out of the legacy change stream; admission, ciphertext, readiness and schedule cursor remain in the matching ScriptAutomationRevision. Explicit resume follows the normal new-revision verification contract and can enqueue the preserved due schedule. Runtime schedules for pending cancellations survive reconciliation; a missing target is not treated as confirmed shutdown.

Actual Prisma/PGlite archive→restore→HTTP list→explicit resume/ready/admission regression and lifecycle suite: 31 passed, 2 existing conditional skips. CLI executor/cache: 140 passed, including failed stop→reconcile→confirmed retry and unavailable-target retention. Server/CLI types, server runtime build and CLI production build passed. Update Happy #812, then pin the reviewed commit in Studio #5039. No CLI publication/install, deployment or PR merge is authorized.

## 2026-10-14 PR preparation

User invoked pushpr. Merged origin/main cafe2446 without conflicts and created [Happy #812](https://github.com/buzzni/happy/pull/812). Post-merge server related 89 tests and CLI runner/environment/cache/executor/API/managed-script 267 tests passed (5 platform conditions skipped); server/CLI type checks, server runtime build and CLI production build passed. Existing production build warnings are unchanged. No runtime installation, CLI release/tag, deployment or PR merge was performed. Studio must pin this branch's final validated commit, followed by Desktop.

Implementation is on `oskar/ordinary-chat-schedules`, based on Studio's pinned `6ec808ce`. The existing source checkout was left untouched. User approved public execution contract extension and excluded all historical migration.

The normal message store and AutomationRun are authoritative; no DB schema was changed. Daemon delivery uses tracked encryption and canonical path plus the existing resume fence. Studio confirms owner/current Chat mapping before delivery. Happy fences the run, definition and session sequence and deduplicates by `happy-automation:<runId>`. A failed delivery never spawns a replacement. A live ordinary provider does not suppress future scheduled runs.

Do not raise protocolVersion for this capability: script readiness deliberately advertises 4 or 5. Capability is encrypted metadata plus explicit payload sync negotiation. Ordinary sessions inherit AI/model/owner tools, so only optional/empty connector policy is supported. Per-run restrictive grants require a different design.

Verification: wire 32, CLI runner/executor/cache/environment 154, API machine and metadata schemas 103, server delivery/execution/socket/service 89 (overlapping reruns excluded where possible). CLI production build and server/CLI types passed. Real Desktop-to-Happy and Happy-to-Desktop NaCl payload 4 smoke passed, including downgrade rejection. PGlite exercises actual Prisma schema/transactions; it is not live deployment or AI-provider execution. Server and CLI changes must ship with Studio and Desktop before new schedules can be used.

Local changes are ready to commit and Studio will consume this validated vendor commit. Preserve release ordering. No push, merge, install, tags or deployment has been performed.

## 2026-10-14 lifecycle local validation

Core Chat deletion/archive/restore lifecycle is implemented with no schema migration. Happy's internal project-config fence survives ordinary config writes; definitions and claims are atomically cancelled/paused and history stays intact. Archived definitions remain paused on restore. Both scope ownership and CAL1 issuer proof are required, because the company's Happy token does not identify the human Chat owner. The cloud proof uses the existing admission secret; standalone uses its existing private server master secret. CAL1 is server-only, bound to scope/action/bearer hash for 30 seconds, and is not exported from the browser wire index.

Deleted tombstones include encrypted targets for CLI cancellation. Pending cancellations are durable until locally verified; missing keys/path do not stop another session. Old conversation-capable caches also resync once after a CLI upgrade so already-consumed tombstones are recovered. Server related 113, wire 35, CLI API/cache/executor/exit-verification 273 passed with 1 platform skip; final cache/executor 138 passed (overlap, not summed). Script/socket consumer suite 56 passed with 2 conditional skips. Wire/server/CLI type checks and production wire/CLI builds passed. Desktop local CAL1 issuer -> Happy verifier smoke passed. Live provider/offline PC stop acceptance and deployment/release remain separate.
