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
