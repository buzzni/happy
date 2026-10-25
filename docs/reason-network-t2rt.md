# T2rt runtime input witnesses

Canonical requirements: Desktop `specs/reason-network-adoption/p0a-contract.md`
§3, §7.1 (T2rt ownership), §7.2, and the approved P1 plan/tasks. This report covers
Happy only; Desktop consumers and release/artifact acceptance belong to later tasks.

## Scope and architecture

Core: authoritative runtime input consumption, host mode transitions and permission
membership belong to the session host. No Extension, new dependency, credential,
owner authority, server schema or provider protocol is introduced.

The input witness is independent of routing `requestIds`, the channel `requestId`
slot and `AutomationTurnTracker`. Original queue entries retain text/attachments
locally for revalidation; only identifiers, counters and states enter evidence.
Automation retains its single-run arming/carry semantics. Its settlement observes
explicit continuation pending/cancel/replacement evidence when present.

Only the independent Happy clone is edited. T1b's `daemon/sessionEnv.ts`,
`daemon/run.ts`, `commands/sessionAgentBroker.ts` and T4o's ownership/export files
are excluded. `sessionProtocol.ts` is T2rt-owned and already exported by the
existing barrel, so no shared export/manifest/lockfile reservation is needed.

## Implementation sequence

1. Reproduce wire stripping and empty-plan behavior with failing tests.
2. Add bounded input-evidence and admission schemas, independent witness state,
   original queue entries and host mode/epoch validation.
3. Wire Claude/Codex dispatch, final candidates, additional input boundaries and
   transient/capacity/account-switch continuation; advertise ACP unsupported evidence.
4. Run focused queue, wire, mapper, permissions, channel, automation and launcher
   regressions plus type/build checks; inspect the complete diff.
5. Commit with the requested co-author trailer and push the task branch. No PR,
   merge, tag, publishing or deployment.

Rollback: revert this branch's behavioral commit. Older runtimes do not advertise
guardedPrompt/inputEvidence; senders must disable guarded delivery rather than
silently removing a guard. Desktop must consume the matching wire contract before
claiming input/answer attribution.

## Verification record

- Initial red: happy-wire `sessionProtocol.test.ts`: 5 new failures, 34 passes
  (three stripped evidence fields and unsupported evidence/admission events).
- Dependency preparation: `corepack pnpm --filter @buzzni/happy-cli --filter
  @slopus/happy-wire install --frozen-lockfile` succeeded; lockfile unchanged.
- Added failing runtime regressions exposed stale continuation snapshots and account-switch
  carry cancellation on the new provider; both were corrected before final verification.
- Iteration checks: wire 39/39; API/evidence 171/171; Claude preparation/switch retry
  11/11; permission provider boundaries 68/68. Later additions are covered by the
  final run below. Existing mocked API/provider fixtures were extended; pure state
  and queue tests use the real implementations.
- Final scoped CLI suite: **31 files / 733 tests passed**, using the standard
  Vitest unit project and its build global setup (CLI `tsc --noEmit`, pkgroll and
  extension copy all succeeded). Command: `corepack pnpm -C packages/happy-cli exec
  vitest run --project unit <files below> --maxWorkers 2`.
- Wire: **39/39 passed** with `corepack pnpm -C packages/happy-wire exec vitest run
  src/sessionProtocol.test.ts`; `corepack pnpm -C packages/happy-wire build` passed.
- `git diff --check` passed. Full-suite, paid-provider and Desktop tests were not run.
- Build printed existing bin-outside-dist/empty-chunk warnings; runtime harnesses
  printed listener/asynchronously-handled-rejection warnings but all assertions passed.

Final CLI selection (paths relative to `packages/happy-cli`):

```text
src/api/turnInputEvidence.test.ts
src/api/apiSession.test.ts
src/api/types.test.ts
src/api/automationTurnTracker.test.ts
src/utils/MessageQueue2.test.ts
src/codex/codexPlanEvent.test.ts
src/codex/codexClearCommand.test.ts
src/codex/codexCapacityRetry.test.ts
src/codex/codexSteerHandler.test.ts
src/codex/__tests__/codexUserInput.test.ts
src/codex/__tests__/permissionHandler.test.ts
src/codex/__tests__/permissionHandler.expiry.test.ts
src/codex/__tests__/codexApprovalBoundary.test.ts
src/claude/utils/permissionHandler.test.ts
src/claude/utils/sessionProtocolMapper.test.ts
src/codex/utils/sessionProtocolMapper.test.ts
src/codex/__tests__/sessionProtocolMapper.test.ts
src/channel/channelTurnOrdering.test.ts
src/channel/channelTurnEnqueue.test.ts
src/channel/channelPermissionMembership.test.ts
src/claude/claudeRemoteLauncher.transientRetry.test.ts
src/claude/claudeRemoteLauncher.setupTokenSwitch.test.ts
src/claude/claudeLocalLauncher.test.ts
src/claude/claudeRemoteLauncher.test.ts
src/codex/runCodex.capacityRetry.test.ts
src/codex/runCodex.channelClear.test.ts
src/codex/runCodex.shutdown.test.ts
src/codex/runCodex.lessonProposal.test.ts
src/claude/runClaude.test.ts
src/claude/runClaudeOfflineAck.test.ts
src/agent/acp/runAcp.test.ts
```
- Happy has no `preflight` script or Desktop release-note/guide gate. No Desktop
  source, generated guide, release version, package manifest or lockfile changed.

## Contract decisions and implementation details

- `UserMessage.serverSeq`, like serverMessageId, comes from the received server row
  after payload parsing. Payload identity, routing requestIds and localKey cannot
  impersonate it. Every original queue item survives dequeue for final validation.
- `MessageMetaSchema.hubPrompt` deliberately retains unknown/malformed values;
  the strict wire guard schema runs at the receiving host. Using only the strict
  metadata schema would discard malformed user messages without their required
  server-bound rejected event. This is an implementation choice, not a new guard version.
- Mode/epoch changes precede abort/await. Queued, held and asynchronously preparing
  Claude batches are revalidated; survivors are requeued with original attachments
  and IDs so already-prepared provider text cannot include a rejected item.
- Synthetic retries carry a cancellable receipt until dispatch. A replacement
  invalidates queued copies; a delayed ACK updates the original and inherited
  descendants, never a new input root. Background continuation retains its weaker
  root grade. An unresolved provider turn marks pending coverage incomplete.
- Unsupported ACP/Gemini and managed contact advertise null input evidence.
  Account-vs-managed comes from the constructor principal, not environment metadata.
- All three retry decisions emit pending before failed end. Automation observes
  that explicit state, with the legacy deferred settlement retained for old
  unstamped callers; `automationTurnTracker.ts` itself is unchanged.

Permission response branches audited:

| Boundary | Additional input and settlement |
| --- | --- |
| Claude ordinary tool / AskUserQuestion | Record before resolve; approved updatedInput or denied free-text reason is accepted when forwarded. Ignored fields remain rejected attempts. |
| Claude ExitPlanMode / exit_plan_mode | Approved mode/allowTools/binary decision adds no text; updatedInput is ignored and is a rejected attempt. Denied reason is forwarded and accepted. |
| Codex request_user_input | Bind native turn to protocol turn; pending before resolve, accepted only after valid answers have been converted to the JSON-RPC response. Missing/ambiguous/aborted answers settle rejected. |
| Codex exec / patch / MCP approval | Bound tool membership; provider receives a decision only, so supplied updatedInput/reason is recorded as an attempted but rejected text addition. |
| Duplicate/expired/aborted request / auto-approval | Existing permission lifecycle rejects or resolves without a new human text write; no fabricated accepted attempt. |
| Unknown shape / missing turn membership | Incomplete coverage, never guessed membership or restored exclusivity. |

No approved public contract change was required. T1c must preserve the T2rt
ACP/Gemini queue configuration when editing those reserved host files next.
Existing `happy-wire/src/index.ts` re-exports sessionProtocol, so no common export
edit or export conflict was introduced.

## Known integration boundaries

- Additional-input acceptance records the host's provider handoff. A rejected or
  unknown attempt remains in terminal snapshots and never restores exclusivity.
- Claude uses the ordered transcript queue; retry decisions precede terminals.
  Account switching preserves evidence on ApiSessionClient across provider restarts.
- Gemini/opencode/grok advertise `inputEvidence: null`; guarded intake does not
  imply that their provider input/output is witnessed.
- Runtime state is process-local. A host restart changes runtimeId; missing events
  after a crash are unknown, never inferred from seq proximity or busy/idle state.
- Live paid-provider runs, Desktop reconstruction/UI, distributed crash recovery,
  registry packaging and cross-repository integration are not established by unit tests.

Status: T2rt implementation and scoped verification complete (2026-10-25).
The requested branch is `feat/rn-t2rt-input-evidence`, based on origin/main
`9ee84191cf6e6b2739987be3f5488ef511c6474f`. The independent working clone is
`/home/walter/workspace/aplus-dev-studio-desktop/.aplus/worktrees/rn-ext/happy-t2rt`.
The coordinating session owns fixed-SHA cross-review, PR creation, downstream
Desktop schema/reducer integration (T1/T2), and packaged runtime acceptance (T2r).
