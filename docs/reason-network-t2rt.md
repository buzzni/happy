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

## Initial implementation verification record

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

## Fixed-SHA cross-review follow-up (2026-10-25)

Review base: `f1f7df93be0e7b584fb51eadeb98519b1a5dd2b1`.
All five findings are accepted. The changes remain within T2rt runtime ownership;
no public wire/API contract, authority, shared export or T1b-owned file changes.
This follow-up is a new behavioral commit, without rewriting the review base.

| Finding | Correction | Regression evidence |
| --- | --- | --- |
| T2RT-01 | Revalidate the original queue batch and synchronously claim a live continuation in the real client's `turn/start` write path, after interrupt/preparation awaits. `stamp()` refuses cancelled retry snapshots; background inheritance remains a separate case. A claimed dispatch cannot be cancelled by later input; Claude's ordered transcript retains the same runtime-owned claim after its provider write. | Actual client interrupt/preparation races write zero requests; real runner drops a retry replaced during preparation and sends B only; stale start cannot restore A; post-claim start retains its root and a delayed ACK; Claude transient/account-switch retries survive delayed transcript processing. |
| T2RT-02 | Retain background observations separately from the queued batch and carry co-consumption reasons into a replacing batch. | Both background→B and B→background produce incomplete coverage. |
| T2RT-03 | Record the background observation even when its source witness has been evicted; mark active/pending coverage incomplete or retain an idle marker until the next turn. | Evict A with 128 subsequent turns, then deliver its notification while active, pending and idle (including pending cleanup); all remain incomplete. |
| T2RT-04 | Runtime snapshots carry exact unresolved attempt tokens in a WeakMap. ACKs settle only snapshots/turns that inherited that token, including attempts omitted by the wire item cap. No root/ordinal-based propagation. | Two background forks with a common attempt and distinct steer attempts settle independently; run both below and beyond the 128-item cap, validate every emitted wire envelope, and reconcile an ACK between claim and start. |
| T2RT-05 | Observe successful `stdin.write` separately from provider ACK/start. A written REST batch that fails without `task_started` receives the same synthetic start/failed end, using its pending witness and no channel requestId. | Actual client writes then rejects before start/ACK; runner emits REST start/failed end with A's identity, while preparation failure emits neither. |

The offline session stub is a direct consumer of the new claim check. It now
retains pending batches in its already-existing local tracker so offline dispatch
continues to work; its publication methods remain no-ops and it advertises no
witness capability. This regression was reproduced before fixing the stub.

Verification sequence:

- Added the five review reproductions before the production fixes: **9 failures /
  196 passes** across evidence state, actual Codex client and capacity runner.
- After fixes and additional race/offline cases, focused iteration: **210/210**
  across those same three files. Iteration alone used an ignored Vitest config
  without build setup; it does not substitute for the standard final run.
- The first standard regression run exposed three Claude transient/account-switch
  failures: provider dispatch had occurred, but shutdown cancelled the carry before
  its ordered transcript was stamped. Added a failing delayed-transcript state
  test, then made the claim travel with the in-process continuation snapshot.
  Focused verification after this correction: **5 files / 232 tests passed**.
- Wire build (including `tsc --noEmit`) and the **39/39** strip/schema tests passed.
- Standard final CLI run: **32 files / 908 tests passed**. Selection is the original
  31 files above plus `src/codex/codexAppServerClient.test.ts`, using
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit <selection>
  --maxWorkers 2`. Standard global setup's CLI `tsc --noEmit`, pkgroll and extension
  copy passed. An initial inferred-state TypeScript error was corrected before this
  successful run. Existing bin/empty-chunk and test-harness warnings remain.
- `git diff --check` passed. No full-suite, paid-provider or Desktop tests were run.
- No finding is deferred or rejected. No approved design change was necessary.
  Real paid providers, Desktop integration and packaged runtime acceptance remain
  outside this local verification, as in the original report.

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
