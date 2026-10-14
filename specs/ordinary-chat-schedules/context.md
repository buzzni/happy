---
feature: ordinary-chat-schedules
status: local-complete
updated: 2026-10-14
---

# Ordinary Chat schedules context

Implementation is on `oskar/ordinary-chat-schedules`, based on Studio's pinned `6ec808ce`. The existing source checkout was left untouched. User approved public execution contract extension and excluded all historical migration.

The normal message store and AutomationRun are authoritative; no DB schema was changed. Daemon delivery uses tracked encryption and canonical path plus the existing resume fence. Studio confirms owner/current Chat mapping before delivery. Happy fences the run, definition and session sequence and deduplicates by `happy-automation:<runId>`. A failed delivery never spawns a replacement. A live ordinary provider does not suppress future scheduled runs.

Do not raise protocolVersion for this capability: script readiness deliberately advertises 4 or 5. Capability is encrypted metadata plus explicit payload sync negotiation. Ordinary sessions inherit AI/model/owner tools, so only optional/empty connector policy is supported. Per-run restrictive grants require a different design.

Verification: wire 32, CLI runner/executor/cache/environment 154, API machine and metadata schemas 103, server delivery/execution/socket/service 89 (overlapping reruns excluded where possible). CLI production build and server/CLI types passed. Real Desktop-to-Happy and Happy-to-Desktop NaCl payload 4 smoke passed, including downgrade rejection. PGlite exercises actual Prisma schema/transactions; it is not live deployment or AI-provider execution. Server and CLI changes must ship with Studio and Desktop before new schedules can be used.

Local changes are ready to commit and Studio will consume this validated vendor commit. Preserve release ordering. No push, merge, install, tags or deployment has been performed.

## 2026-10-14 lifecycle local validation

Core Chat deletion/archive/restore lifecycle is implemented with no schema migration. Happy's internal project-config fence survives ordinary config writes; definitions and claims are atomically cancelled/paused and history stays intact. Archived definitions remain paused on restore. Both scope ownership and CAL1 issuer proof are required, because the company's Happy token does not identify the human Chat owner. The cloud proof uses the existing admission secret; standalone uses its existing private server master secret. CAL1 is server-only, bound to scope/action/bearer hash for 30 seconds, and is not exported from the browser wire index.

Deleted tombstones include encrypted targets for CLI cancellation. Pending cancellations are durable until locally verified; missing keys/path do not stop another session. Old conversation-capable caches also resync once after a CLI upgrade so already-consumed tombstones are recovered. Server related 113, wire 35, CLI API/cache/executor/exit-verification 273 passed with 1 platform skip; final cache/executor 138 passed (overlap, not summed). Script/socket consumer suite 56 passed with 2 conditional skips. Wire/server/CLI type checks and production wire/CLI builds passed. Desktop local CAL1 issuer -> Happy verifier smoke passed. Live provider/offline PC stop acceptance and deployment/release remain separate.
