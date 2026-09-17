# Automation request surge — server

Date: 2026-09-17. Authorized: user requested planning, delegated implementation, primary-agent review and correction.

## Goal
Stop automation change events multiplying into account-wide HTTP bursts while preserving state correctness.

## Evidence
2026-09-17 11:35–11:40 KST: 27,722 requests; Electron 82.9%; four automation GET routes 60.8%; peak dashboard 16,761 req/min. Production server emits projectId:null for ACK/claim/start/report; Desktop interprets null as all projects. Exact initiating automation is not established.

## Requirements
R1. Automation claim/start/report and sync acknowledgement publish updates only for affected projects; never invalidate every project for a project-scoped change. Resolve IDs from authoritative authorized service results, not untrusted client project IDs.
R2. Idempotent/no-change ACKs do not create repeated invalidation events. Preserve project owner/member recipients and compatibility of existing wire events.
R3. Machine/viewer-key changes retain necessary scope; avoid losing refreshes or leaking project membership. Existing true account-wide changes remain compatible.
R4. Preserve mutation transactions, ownership checks, claim/revision semantics and response payload compatibility. Add boundary regression tests for affected-project routing, no-op acknowledgement, failed operations, and recipients.
R5. Check existing HTTP request count/duration metrics for normalized route labels; document exact metric names and labels for monitoring agent. Do not invent new high-cardinality labels.

## Out of scope
Production mutation, publishing, release, push/merge, CPU scaling, unrelated cleanup. Local implementation and verification only.
