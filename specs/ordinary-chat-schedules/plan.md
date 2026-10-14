# Ordinary Chat schedules plan

Core owns the run, session and encrypted message consistency. payloadVersion 4 seals `conversation.sessionId`; 3 remains script-only. Keep protocolVersion unchanged because script readiness uses its 4/5 gate. Publish encrypted machine metadata `automationSupport.conversation: true` and explicitly negotiate sync `payloadVersions: [1, 4]`. Old sync callers receive tombstones for v4. Resync pre-capability disk caches once.

1. Wire mode and version validation, capability negotiation and cache recovery.
2. Current Chat authorization through Studio; tracked-session keys/directory and existing resume fence.
3. Atomic claim/generation/key/permission/sequence validation and run-localId delivery in existing Prisma transaction; emit the normal encrypted message update.
4. Related tests, production CLI build, server types and contract smoke; record deployment limitations.

The existing provider retains ordinary owner permissions and AI settings. Reject per-run restrictive connector policies instead of claiming they were applied to a live session. No replacement session on failure. Roll back by pausing v4 definitions and reverting versions, preserving all ordinary messages. Do not convert v4 into v1. Deploy Happy server, Studio, CLI, then Desktop; tags/install/release/push require separate authorization.
