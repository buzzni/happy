# T2rt runtime input witnesses

Canonical requirements: Desktop `specs/reason-network-adoption/p0a-contract.md`
§3, §7.1 (T2rt ownership), §7.2, and the approved P1 plan/tasks. This report covers
Happy only; Desktop consumers and release/artifact acceptance belong to later tasks.

## Current scope decision (2026-10-26)

PR #951 **only adds runtime input evidence**. Background channel routing remains
exactly the scanner-driven behavior of `9ee84191` (the merge base). This user
scope decision supersedes the routing requirements and claimed routing fixes in
all historical review rounds below: nine rounds of routing regressions resulted
from T2rt changing routing. Routing hardening belongs to separate follow-ups.

SDK task starts/notifications feed an evidence-only dispatcher entry point. They
cannot close/open turns, rearm/consume channel requests, or alter launch ownership.
The mapper retains main's original request map, parser, rearm function and
notification/tool-result routing blocks. Bounded completion/launch state,
default-deny proof and history-loss state now affect **evidence only**. An observed
SDK receipt is not proof of provider consumption: its coverage is incomplete with
`background-consumption-unproven`. A consumed scanner row may retain complete
coverage only with already-observed launch/identity proof; otherwise it is
incomplete with a background reason. Missing starts never borrow an earlier
launch's run ID. Scanner consumption staged before the previous terminal is
stamped belongs to the next evidence turn.

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

## SDK delivery and failed-write follow-up (2026-10-25)

Review base: `dcbfb2453ce262e0d8c49a6c3745961ec0483ad0`.
T2RT-01/04/05 remain closed. The prior T2RT-02/03 tests established the state
transition only; they did not establish SDK delivery through the outgoing filter.
Both reopened findings and T2RT-06 are accepted and implemented in this follow-up.

| Finding | Correction and executed reproduction |
| --- | --- |
| T2RT-02 | `OutgoingMessageQueue.enqueue` preserves converted SDK `system/task_notification` as an internal ordered item. The existing dispatcher unwraps it into the normal session mapper; ordinary system logs remain filtered. Tests run the real SDK converter, outgoing queue, context-usage wrapper, dispatcher and mapper, with real background launch/result messages and delayed assistant output. B's final/end witness is incomplete before any scanner row arrives, with the notification arriving while B is active, pending, or before B is queued. |
| T2RT-03 | The same production-path scenarios first process 128 later turns to evict A. The SDK notification then marks B incomplete with `background-source-unavailable` in all three arrival states. No test directly invokes `rearmBackground()` as its stimulus; only the mapper's real callback does so. |
| T2RT-06 | The runner's catch settles a pending claim when no successful write was observed, before finally clears the batch. It publishes a terminal `cancelled` evidence revision for the original continuation, preserving its turn/root rather than inventing a dispatched retry. The regression runs the real consumer loop and `CodexAppServerClient.sendTurnAndWait` → `sendTurn` → `request`; the failed dispatch uses a fake process stdin whose `write()` throws synchronously after claim. Initial overload and external API boundaries remain scripted. The test verifies one attempted failing write, the original terminal revision, and no extra turn-start. |

Verification:

- Before production changes: **7 failed / 36 passed** in
  `channel/channelTurnOrdering.test.ts` and `codex/runCodex.capacityRetry.test.ts`.
  Six SDK-path cases ended B with complete coverage; the actual failed-write case
  left A pending and nonterminal.
- After correction: both files passed, **43/43 tests**.
- Standard validation caught a missing method in the existing Codex lesson
  fixture; the fixture now implements the new settlement method. That run also
  exposed an unmodified ACP test's timing race: it waits for session creation but
  calls the kill handler before registration, leaving a run that affects the next
  test. No ACP implementation/test was changed. Isolated consumer rerun passed
  **58/58** across the two files.
- Final standard CLI selection: **34 files / 960 tests; 959 passed, 1 startup
  timeout** in the unmodified `claude/runClaude.test.ts` harness's `mockLoop`
  wait (line 260, before its scenario). That entire file then passed **62/62** in
  isolation without code/test changes. The ACP suite passed in this final run.
  These are separate results, not a claim that the bulk run was all green.
- Selection: the original 31 files above plus `codex/codexAppServerClient.test.ts`,
  `claude/utils/sdkToLogConverter.test.ts` and `claude/claudeContextUsage.test.ts`
  (all under `src/`). Command: `corepack pnpm -C packages/happy-cli exec vitest run
  --project unit <selection> --maxWorkers 1`. Standard global setup completed CLI
  `tsc --noEmit`, pkgroll and extension copy successfully. Isolated reruns used
  the ignored iteration config without repeating the already-passed build.
- Wire: `corepack pnpm -C packages/happy-wire build` (including typecheck) passed;
  `sessionProtocol.test.ts` passed **39/39**. `git diff --check` passed.
- Existing bin/empty-chunk and harness listener/rejection warnings remain.
  Full-suite, paid-provider, Desktop integration and packaged acceptance were not
  run. The unrelated startup timing races are follow-up test-harness work, not
  changes bundled into this runtime fix.
- No finding is deferred. No public schema/authority change or design change is
  required. The internal queue item and its type stay in their owning modules;
  no package barrel, manifest, lockfile or T1b file is edited.

## Third fixed-SHA cross-review follow-up: T2RT-07 (2026-10-25)

Review base: `495c743f7c99b8d4ac7e7c47c4ecf7140e543dbc`.
Historical record: round 4 below replaces this unbounded ledger and its cross-source identity inference.
T2RT-07 is accepted. The SDK receipt and the scanner's richer row describe one
consumed completion, despite their intentionally different display IDs. The mapper
now records completion identity in its runtime-local state before applying turn
closure, evidence rearming or channel request rearming. Duplicate observations
still emit their original text/display ID but cannot close or contaminate an
already-running follow-up or a later unrelated batch.

Identity uses the task (tool ID when task ID is absent), subagent scope, normalized
terminal status, and the provider's `run_id` / scanner `origin.runId`. The installed
SDK documents these run IDs as shared across events and saved notifications, and
as changing when a task resumes. A distinct explicit run remains a new observation.
For older/metadata-poor rows, task/status is the available identity; the missing source
can bind a later explicit run ID to an unidentified receipt rather than consuming
it again. Once both legacy sources have arrived, a later explicit run is new input. Nonterminal
Monitor events are not deduplicated. Receipt identifiers remain for the mapper's
runtime lifetime rather than expiring with the bounded turn/task maps, so late
scanner delivery cannot turn an already-observed completion into unknown input.
The ledger stores identifiers only, not transcripts or witness snapshots.

Regression tests use the actual SDK converter → outgoing queue → context-usage
wrapper → ordered dispatcher → mapper and evidence state. Scanner rows enter via
the separate session-message method used by the scanner boundary, bypassing the SDK
queue. Tests cover both delivery orders, both/missing/one-sided run metadata, and
the second observation arriving during F, after F while idle, or during unrelated
B. They assert the final-answer's original channel request ID and witness root,
complete terminal coverage, a single rearm, B's separate input root, and preservation
of the scanner details and receipt's different display ID. Explicit resumed runs
remain observable as new input.

Verification:

- First reproduction on unchanged production code: **6 failed / 21 passed** in
  `channel/channelTurnOrdering.test.ts`. During F, the scanner removed final-answer
  correlation and degraded the witness; after F, it contaminated B (and removed
  B's correlation when B was already running). All six called rearm twice.
- The first correction passed those six cases and the existing mapper regressions
  (**77/77**). Expanded integration tests then exposed one-sided run metadata:
  **12 failed / 33 passed**. Binding metadata-poor receipts fixed those cases.
- An additional resumed-run control exposed **6 failed / 39 passed** when a
  completion already observed from both legacy sources absorbed a new explicit
  run. Recording the sources of unidentified receipts fixed this case. The final
  integration fixtures use the actual isolated channel input descriptor.
- Final focused iteration: **95/95** across channel ordering (45) and the Claude
  mapper (50), using the ignored iteration config without global build setup.
- Final standard related suite: **16 files / 468 tests passed** with
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit <selection>
  --maxWorkers 1`. Its standard global setup completed CLI `tsc --noEmit`, pkgroll
  and extension copy successfully after the final production change.
- Wire consumer schema regressions: **39/39 passed**, using `corepack pnpm -C
  packages/happy-wire exec vitest run src/sessionProtocol.test.ts`.
- `git diff --check` passed. Existing bin-location/empty-chunk build warnings and
  asynchronously-handled-rejection harness warnings remain. No failing tests in
  the final selection. Full-suite, live paid-provider, Desktop and packaged
  acceptance checks were not run.

Related CLI selection (all under `src/`, standard Vitest `--project unit`,
`--maxWorkers 1`):

- `api/{apiSession,automationTurnTracker,turnInputEvidence}.test.ts`
- `channel/{channelPermissionMembership,channelTurnEnqueue,channelTurnOrdering}.test.ts`
- `claude/utils/{sdkToLogConverter,sessionProtocolMapper,sessionScanner}.test.ts`
- `claude/{claudeContextUsage,claudeLocalLauncher,claudeRemoteLauncher,claudeRemoteLauncher.setupTokenSwitch,claudeRemoteLauncher.transientRetry,runClaude,runClaudeOfflineAck}.test.ts`


No finding is deferred. No public API/schema, authority, shared export or T1b-owned
file changes are needed. This is an internal implementation correction within the
approved contract, with no design deviation. Only the mapper, its existing channel
integration test file and this report change. No new files or dependencies.

## Round 4: T2RT-08 / T2RT-09 (2026-10-25)

Review base: `415c1b303528ae8143538ce3be90e7b43e688cd7`.
Both findings are accepted. This round replaces the deduplication model rather
than adding another source-pairing exception.

The internal `backgroundCompletionTracker.ts` owns one bounded map keyed by
runtime-local scope, task (tool ID only when task ID is absent), and explicit run
identity. Each record has one terminal status and a `started` → `observed` →
`settled` lifecycle. There are no per-task run sets or missing-counterpart sets.
Only an observed matching explicit run/status proves a duplicate. Different
sources do not prove equality, and a currently started run is never assigned to
a metadata-poor scanner row. The ordered queue now preserves SDK `task_started`
generation events as well as completion receipts; repeated starts cannot reset
an already-consumed run.

Normal turn end and manual AskUserQuestion cancellation release active turn
ownership. Bounded settled identity tombstones remain because deleting every
identity at turn end would recreate T2RT-07 when the scanner arrives later.
The map holds at most **200 records in total**, including starts, distinct tasks
and repeated runs of one task; identity keys exceeding **4096 UTF-8 bytes** are
not retained. FIFO eviction/oversized identity sets a constant-size `historyLost`
flag. Thereafter a cache miss is uncertain, not proof of new exclusive input.
Exact retained identities can still be deduplicated. This deliberately favors
incomplete coverage for unseen background completions after history loss until
a new runtime is created; ordinary batches without such observations are not
globally downgraded.

Uncertain observations use the existing evidence callback without source IDs.
They reduce current/pending coverage or preserve an unknown-input marker while
idle, but cannot claim a retained launch mapping, rearm a channel request, or
close a live turn. A first scanner-only legacy completion still follows the old
launch/root/request path. A later ambiguous or distinct-run observation is never
silently discarded as its missing counterpart.

Scanner attachment promotion preserves `origin.runId`, with `attachment.runId`
as fallback, matching the installed SDK's `sdk.mjs` queued-command promotion and
`sdk.d.ts` task-run contract. Origin metadata, detailed text, and the scanner's
separate display ID remain available. No new wire fields or identity guesses.

Tests and semantic clarification:

- Before production changes, real converter/queue/dispatcher/mapper integration
  tests had **6 failures / 45 passes**: four scanner-only/SDK-only legacy → F ends
  → B → opposite-source explicit run-2 cases (with/without a start event), plus
  600-task and 600-run retention cases. B incorrectly stayed complete; the old
  ledger retained 600 keys or 600 runs of one key.
- Real file-scanner attachment regressions first failed **3/3** (9 existing tests
  passed): origin run ID, attachment fallback, and precedence when both exist.
- A manual question-cancellation API regression first failed **1/1**: the turn
  ended but its completion still held active ownership. The manual path now uses
  the same end transition as the mapper.
- Focused correction passed **274/274** across four files. The channel integration
  file subsequently passed **55/55**, including two additional real SDK queue →
  follow-up end → B → file-scanner attachment → final/end cases.
- Retention tests cover 600 distinct tasks and 600 runs of one task, both with B
  active and with the runtime idle. The idle case leaves a newer launch mapping
  for the same task: the evicted old completion must not inherit that source or
  its channel request. All retained consumed records release their turn fields.
- The earlier 24 ordering cases still preserve request IDs and roots. The six
  cases with shared explicit run identity retain complete coverage and one
  rearm. The 18 cases lacking shared run identity now intentionally mark the
  affected F/B incomplete rather than asserting a duplicate they cannot prove,
  as required by T2RT-08. Detailed scanner text remains visible in either case.
- Final standard related CLI selection: **16 files / 482 tests passed** with
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit <selection>
  --maxWorkers 1`. Standard global setup passed CLI `tsc --noEmit`, pkgroll and
  extension copy against the final production changes.
- Wire schema regressions: **39/39 passed** with `corepack pnpm -C
  packages/happy-wire exec vitest run src/sessionProtocol.test.ts`.
- `git diff --check` passed. Existing bin-location/empty-chunk build warnings and
  asynchronously-handled-rejection harness warnings remain; no final test failed.
  Full-suite, live paid-provider, Desktop and packaged acceptance were not run.

The related CLI selection is the same 16 files listed in round 3. The two findings
are not deferred. This changes internal evidence bookkeeping within the existing
conservative-coverage contract; no public API/schema/authority changes or design
change approval are needed. Eight existing files and one internal tracker module
are changed, including this report. T1b files, shared barrels, manifests and the
lockfile are untouched. No Desktop, release, or UI-guide changes are included.

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

## PR #951 managed startup CI follow-up (532e478f)

The macOS failure in run `40180291288` was reproduced unchanged on Linux:
`managedCodexStartup.test.ts` had 5 failures and `managedRunnerStartup.test.ts`
had 13 (18 failed / 9 passed, plus two unhandled startup rejections). The Claude
harness catches the startup rejection and waits for an unreached loop/ACK spy,
so its timeout assertions obscure the same missing `configureInputQueue` method.

This is a test-double gap, not a managed runtime regression. Both account and
managed branches of `ApiClient.sessionSyncClient()` construct `ApiSessionClient`;
its queue configuration method is unconditional and its contact capability logic
explicitly handles the managed principal. The only alternate production session,
`createOfflineSessionStub()`, already provides the method. The managed attachment
integration test now asserts that the real factory result provides queue and steer
configuration. The two runner fixtures now supply their consumed API methods
(`configureInputQueue`, plus Codex's later `setInputSteerAvailable`), and their
existing startup controls assert the queue configuration call. No production
fallback, optional method, authorization or witness contract was changed.

These files are not macOS-only. The workflow's macOS job runs the unit project;
the Linux smoke job builds and exercises packaged binaries/browser smoke without
running that unit project. All local checks below use Linux / Node 20.18.3, with
no platform override for the managed startup files. Native macOS execution remains
CI's responsibility.

Audit: searched the entire CLI package for `configureInputQueue`, session factories,
`ApiSessionClient` references/casts, offline creation, user/message callbacks,
RPC/session stubs and permission-handler fixtures. Runner doubles for ordinary
Claude, Codex and ACP already provide queue configuration. OpenClaw and partial
launcher/MCP/permission/steer doubles do not call that API at their tested boundary;
they remain deliberately partial and were included in verification. Machine API,
provider app-server, DTO-only and browser-client objects are different contracts,
not alternative implementations of `ApiSessionClient`.

Verification:

- Red and first green used the ordinary unit setup with only the repeated build
  global setup disabled in an ignored iteration config. Both requested files
  changed from 18 failures to **27/27 passing**; with real attachment coverage,
  the initial green was **35/35** in three files.
- Standard audit command: `corepack pnpm -C packages/happy-cli exec vitest run
  --project unit <46 files below> --maxWorkers 1`. Global setup passed CLI
  `tsc --noEmit`, pkgroll and extension-copy build (existing bin-location and
  empty-chunk warnings). Result: **41 files passed / 5 failed; 1021 tests passed /
  52 failed / 2 skipped**, plus one ACP unhandled rejection. Both requested
  files passed again (27/27), as did the real attachment file (8/8).
- Of the audit failures, **50** are Unix socket creation failures with
  `listen EPERM` under `/tmp/happy-mcp-*/mcp.sock`: `startHappyServer.test.ts`
  (28), `checkpointAgentReader.test.ts` (11), `turnCardTools.test.ts` (9) and
  `mandatoryMcp.test.ts` (2). These could not be verified in this execution
  environment; no `configureInputQueue` failure remains. The two native Claude
  scope tests are opt-in skips (`HAPPY_SCOPE_NATIVE_CLAUDE` unset).
- The two ACP failures were a 1-second startup wait and a 5-second approval
  wait, with an associated `Session terminated` rejection. Re-running the
  unchanged `src/agent/acp/runAcp.test.ts` alone with the iteration config passed
  **24/24**, without an unhandled error; the aggregate timing failure is still
  recorded rather than representing the initial audit as green.
- `git diff --check` passed. There is no Happy preflight script; the standard
  unit global setup supplied the applicable type/build checks.
- Separately, `src/codex/codexSteerHandler.test.ts`: **6/6 passed**.
- Also attempted the matched `src/claude/claude.integration.test.ts` through its
  `integration-empty` project. Environment setup failed before collecting tests:
  `Migration failed with exit code null` from the temporary environment's server
  migration subprocess. This is **not a pass**; no paid-provider scenario ran.
  The fixture belongs to the direct SDK/MCP path, which never configures an input
  queue. Its MCP consumer was also attempted in the selected unit files, subject to
  the Unix-socket restriction above.
- No release fragment: this follow-up changes only tests and this report. No
  Desktop files, T1b files, exports, dependency manifests or lockfiles changed.
- Delivery for this follow-up is **local commit only**. The parent session owns
  pushing after the PR review bot finishes; no push or PR operation is performed.

Audit unit selection (paths relative to `packages/happy-cli`; standard unit project):

```text
src/agent/acp/runAcp.test.ts
src/api/apiSession.test.ts
src/api/apiSessionContextUsage.test.ts
src/api/apiSessionManagedOrigin.test.ts
src/api/apiSessionRuntimeAccount.test.ts
src/api/apiSessionSocketPath.test.ts
src/api/turnInputEvidence.test.ts
src/channel/channelPermissionMembership.test.ts
src/channel/channelPromptAcceptance.test.ts
src/channel/channelTurnOrdering.test.ts
src/checkpoint/checkpointAgentReader.test.ts
src/claude/claudeLocalLauncher.test.ts
src/claude/claudeRemote.test.ts
src/claude/claudeRemoteLauncher.aiAuthObservation.test.ts
src/claude/claudeRemoteLauncher.setupTokenSwitch.test.ts
src/claude/claudeRemoteLauncher.standaloneDrain.test.ts
src/claude/claudeRemoteLauncher.structuredOutput.test.ts
src/claude/claudeRemoteLauncher.test.ts
src/claude/claudeRemoteLauncher.transientRetry.test.ts
src/claude/claudeRemoteLauncherContextUsage.test.ts
src/claude/initialPrompt.test.ts
src/claude/runClaude.test.ts
src/claude/runClaudeOfflineAck.test.ts
src/claude/session.test.ts
src/claude/utils/mandatoryMcp.test.ts
src/claude/utils/permissionHandler.expiry.test.ts
src/claude/utils/permissionHandler.resolution.test.ts
src/claude/utils/permissionHandler.test.ts
src/claude/utils/startHappyServer.test.ts
src/claude/utils/turnCardTools.test.ts
src/codex/__tests__/codexApprovalBoundary.test.ts
src/codex/__tests__/codexUserInput.test.ts
src/codex/__tests__/permissionHandler.expiry.test.ts
src/codex/__tests__/permissionHandler.test.ts
src/codex/codexAppServerClient.test.ts
src/codex/runCodex.capacityRetry.test.ts
src/codex/runCodex.channelClear.test.ts
src/codex/runCodex.lessonProposal.test.ts
src/codex/runCodex.shutdown.test.ts
src/daemon/sessionWriteScopeClaude.test.ts
src/managed/managedApprovalConsumer.test.ts
src/managed/managedCodexStartup.test.ts
src/managed/managedRunnerStartup.test.ts
src/managed/managedStartupAttach.test.ts
src/openclaw/runOpenClaw.test.ts
src/toolPolicy/grants.test.ts
```

## Round 5: route proven launches after completion eviction (2026-10-25)

Historical record: T2RT-10 below supersedes this round's tool-ID fallback for
uncertain completions. A reusable tool ID alone does not identify a run.

Started from `281f5a02`, directly above the parent-integrated review fix `3aa3b97d`.
The stopped-batch and oversized-final-answer fixes are preserved. This follow-up
supersedes round 4's blanket refusal to route every `uncertain` completion; it does
not weaken completion deduplication or restore complete evidence after history loss.

The old task/tool → request map did not say which run owned a retained channel
request. It is replaced with one launch record per `(subagent, taskId)`, containing
the tool-use ID, optional run ID and original request ID. `task_started` binds its
run to the spawning tool's actual turn membership (including hidden Task calls),
or to the same retained launch. A matching tool result preserves that run binding,
regardless of whether start or result arrived first. Neither path borrows the
request of an unrelated currently active turn. Older SDK run IDs cannot overwrite
a newer launch; the installed SDK explicitly guarantees lexical opening order.

Routing proof and evidence completeness are now separate:

- A retained task/run match, or an explicit matching launch tool ID without a
  conflicting run, can rearm the original channel even when completion history
  has overflowed. The follow-up retains available source/root evidence, but adds
  `background-completion-uncertain` and stays `coverage=incomplete`.
- A run or tool mismatch vetoes routing. In particular, an evicted earlier run
  cannot consume the mapping for its successor, even if its tool ID matches.
- An unproven uncertain completion leaves the newer launch available, adds
  `background-request-unrouted` alongside the existing unknown-source reasons,
  and writes `[claude] Background completion not routed` to the file logger.
  Missing launch mappings or an occupied different channel also get that signal;
  an active/pending unrelated request is never replaced. Log identity fields are
  bounded and contain no provider output or prompt text.
- Launch memory has its own **200-record / 4096-byte-per-record** limit. Repeated
  runs of one task replace one record instead of accumulating run sets. Consumed
  matched launches are removed; evicted mappings cannot be reconstructed from
  the currently active channel. Completion tombstones retain their existing,
  separate 200-record budget and conservative unknown-history behavior. A known
  non-channel launch is distinct from an unobserved owner, so a detached run with
  matching task/run IDs still produces the unrouted signal if ownership is absent.
  Revisit these budgets if the new diagnostics show routine eviction of active
  launches; increasing retention must not turn a cache miss into routing proof.

The two new coverage reasons use the existing bounded string-list contract. No
wire schema, public command, channel request slot, authority, dependency, barrel
or T1b file changes are needed. Changes stay in the mapper, internal evidence
callback/state, real-path ordering tests and this report (five existing files).

Verification:

- TDD red: **7 new integration cases failed** on the real SDK converter → outgoing
  queue → context/ordered dispatcher → mapper/evidence path, with scanner delivery
  through its independent session boundary. Exact completions lost `channel-A`;
  unproven old completions lacked the new observability reason/log. Two additional
  failing assertions covered registered but ownerless runs before the final fix.
- The final regression selection includes SDK-first/scanner completions, start
  before/after tool result, explicit tool-only launch identity, an earlier run
  delivered before the new run, and 600 distinct tasks / 600 runs of one task.
  New exact follow-ups must retain `channel-A` and the available source root while
  incomplete; old/evicted completions must not route or consume the new launch.
- Existing **24 T2RT-07 cases** retain their channel/root/coverage/dedup assertions.
  The old exact reason-array assertion now requires its existing reason via
  `arrayContaining`, allowing the newly required observable unrouted reason.
  Existing **4 T2RT-09 eviction cases** remain unchanged. The hidden Task
  scanner-only path is covered by the existing mapper tests.
- Final standard related run: **10 files / 424 tests passed**, including all
  eight round-5 cases, the 24 T2RT-07 cases and the four T2RT-09 cases. Standard
  global setup passed CLI `tsc --noEmit`, pkgroll and extension-copy build against
  the final changes. Existing bin-location/empty-chunk build warnings remain.
- An earlier aggregate run had four existing `runClaude` loop-spy wait timeouts;
  its isolated rerun passed 62/62, and the final standard run above passed them
  all again. No startup-test timeout or fixture behavior was changed this round.
- `git diff --check` passed. No whole-suite, live paid-provider, native macOS,
  Desktop or packaged-release acceptance is claimed.

Final standard unit selection (`corepack pnpm -C packages/happy-cli exec vitest
run --project unit <files> --maxWorkers 1`):

```text
src/channel/channelTurnOrdering.test.ts
src/claude/utils/sessionProtocolMapper.test.ts
src/api/turnInputEvidence.test.ts
src/api/apiSession.test.ts
src/claude/utils/sdkToLogConverter.test.ts
src/claude/utils/sessionScanner.test.ts
src/claude/claudeRemoteLauncher.test.ts
src/claude/claudeRemoteLauncher.transientRetry.test.ts
src/claude/claudeRemoteLauncher.setupTokenSwitch.test.ts
src/claude/runClaude.test.ts
```

Delivery: a new behavioral commit and normal push on the existing branch, as
requested for round 5. No history rewriting, new PR, merge, release or deployment.

## Round 6: T2RT-10 blocks unproven run-ID-less completions (2026-10-25)

Review base: `666faa968a81c7d27c0ca55f4f83a07159511485`.
T2RT-10 is accepted. The user approved safe refusal: **wrong delivery 0 takes
priority over availability**. A resumed task can retain both task and tool IDs;
the absence of a conflicting run ID is not proof that a completion belongs to
the retained launch.

Completed implementation and scope (Core, within existing session-host ownership):

1. Reproduce SDK and scanner late run-ID-less receipts after run-1 → same-tool
   run-2 → 205 unrelated completions, through the real production queue/mapper.
2. Require a shared explicit run ID for an `uncertain` completion to consume a
   retained launch. The current records contain no independently proven
   generation-specific launch identity, so neither task nor tool equality can
   substitute. Keep existing legacy routing for first observations where the
   tracker has no ambiguity/history loss; do not infer uniqueness after eviction.
3. Report `background-request-unrouted` and incomplete coverage with empty source
   IDs when proof is absent. Preserve the launch and source mappings, do not
   rearm the channel, and let the later exact run-2 completion retain channel-A.
4. Run the external reproduction and related standard unit selection, including
   T2RT-07/09, CLI typecheck/build, and diff validation; commit on top of the
   review base and push normally to the existing branch.

Only the mapper, its existing channel ordering tests and this report change.
No public API/schema, dependency, authority, UI, Desktop or T1b file changes.
Rollback is a revert of this behavioral commit. Revisit the availability limit
only if a producer supplies an independently verifiable generation identity;
cache retention, source pairing and a unique current tool match are insufficient.

Verification:

- TDD red on unchanged production code: both new repository SDK/scanner cases
  failed (**2 failed / 63 skipped**) with the standard unit command below. The
  external `/tmp/happy-t2rt-xr-v5/adversarial.test.ts` independently reproduced
  exactly the reported failures (**2 failed / 5 passed**): the old receipt took
  channel-A and deleted the run-2 launch; the exact run-2 answer was unrouted.
- After the fix, the unchanged external reproduction passed **7/7**. Both SDK
  and scanner output show no request ID on the late receipt, the retained
  `{taskId: job, toolUseId: launch-original, runId: run-2, requestId: channel-A}`
  launch, and `requestId=channel-A` on the real run-2 final. Both controls and the
  oversized-answer checks pass. Command: `corepack pnpm -C packages/happy-cli
  exec vitest run --config /tmp/happy-t2rt-xr-v5/vitest.config.mjs --configLoader
  runner /tmp/happy-t2rt-xr-v5/adversarial.test.ts --maxWorkers 2`.
- The two existing post-eviction tool-only cases now require safe refusal and
  retained mappings, including when neither side ever supplied a run ID. The
  existing first-observation legacy mapper cases retain their routing assertions.
  All 24 T2RT-07 and four T2RT-09 cases remain unchanged.
- Final standard related suite: **10 files / 426 tests passed**, including all
  **65 channel ordering cases**, the unchanged **24 T2RT-07** and **four T2RT-09**
  cases, and both new T2RT-10 SDK/scanner cases. Standard global setup completed
  CLI `tsc --noEmit`, pkgroll and extension-copy build successfully against the
  final production change. Selection is the same ten files listed in round 5,
  with `--maxWorkers 2`:
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit <files>
  --maxWorkers 2`.
- `git diff --check` passed. Existing bin-location/empty-chunk build warnings and
  asynchronously-handled-rejection harness warnings remain. No final test failed;
  no Unix-socket EPERM failure occurred in this selection. No whole-suite, live
  paid-provider, Desktop or packaged-release acceptance is claimed.

## Round 7: T2RT-11/12 default-deny routing proof (2026-10-25)

Review base: `93420d6d35e1f3505648095cbfc7149dc70acd57`. Both findings are
accepted and addressed together within Core's existing runtime ownership.
This round supersedes all earlier first-observation fallbacks: parsing failure,
an unfamiliar alias or a cache miss is never positive routing proof.

Implementation:

1. Retain the reviewer's missing/unknown/nonterminal-status and task-to-tool
   namespace reproductions, including refused receipt → real queued-command
   scanner attachment → exact current-run completion.
2. Use one positive proof predicate before any channel rearm, source consumption
   or launch deletion. Require a recognized terminal status and consistent launch
   identity/ownership, plus either a shared exact scoped task/run ID or a provably
   unique legacy launch. Legacy uniqueness requires intact history and no recorded
   ambiguity, prior completion, resume, spawning-turn reuse or task/tool alias
   change. Missing, unknown and nonterminal statuses are refused even with
   matching explicit run metadata.
3. Canonicalize scoped task/tool aliases in the completion tracker and retain
   ambiguity across turn ends and launch consumption. Bound aliases as well as
   completions; losing either history permanently disables legacy inference for
   this runtime. The completion budget stays 200; the alias budget is 400 keys,
   with a 4096-byte bound on each incoming identity. No per-task run sets grow.
   Known explicit duplicates remain harmless observations. Explicit task IDs
   retain distinct run tombstones even when recycled tools connect their alias
   history: the SDK promises run identity per task, not global run-ID uniqueness.
4. Refusal calls the evidence callback with empty source IDs and
   `background-request-unrouted`, preserves all launch/source mappings and keeps
   coverage incomplete. Wrong delivery 0 continues to take priority over
   availability. Revisit only with independently verifiable generation evidence.
5. Exercise 4 statuses × 6 identities × 2 history states × 2 prior states = 96
   cells through each of SDK and real file scanner (192 cases). Each cell checks
   its initial routing decision, then replays an old receipt against a newer live
   channel and verifies exact-run recovery. Keep four first-terminal legacy
   controls and all existing ordering/deduplication regressions. Six additional
   SDK/file-scanner cases check spawning-turn reuse, partial start metadata and
   task changes sharing the same run string/tool. All generation changes stay
   ambiguous for legacy routing, while exact current task/run receipts can route.

Only the internal tracker, mapper, their existing channel/mapper tests and this
report change. No dependency, public API/schema, authority, Desktop, T1b or UI
change. Rollback is a revert of the new behavioral commit. No new files.

Verification:

- Unchanged external v6 harness at the review base: **6 failed / 6 passed**.
  Missing/unknown/nonterminal status and task-to-tool namespace changes consumed
  the newer launch; both real-file scanner cases produced deliverable stale
  Desktop channel outcomes and lost the exact current-run answer.
- TDD: the initial 200-case repository selection failed **137/200** before the
  implementation (the four first-terminal legacy controls passed). The four
  spawning-turn/partial-start cases and two scoped task/run cases were then added
  red before completing the unified identity model; all six failed as intended.
- The first standard related run passed **629/630**, including all 269 ordering
  cases then present. Its only failure was an old mapper fixture expecting a
  missing-status SDK row to rearm. Both that duplicate-preservation fixture and
  the hidden-Task correlation fixture now provide explicit terminal status.
  Missing-status refusal remains covered by the matrix rather than preserving
  a contradictory positive expectation.
- Final external reproduction: **18 passed / 1 deliberately excluded** across
  v5 (7/7, preserving T2RT-10) and v6 (11/11 selected). The v6 harness's old
  `scanner-legacy-no-status` positive control is excluded because it conflicts
  with the approved rule. The other safety reproductions/legacy controls are
  unchanged. Both real-file scanner attacks now produce `outcomes=[]`, retain
  the current launch, and deliver the exact current task/run answer to channel-A.
  Command, from the clone root:

  ```sh
  corepack pnpm -C packages/happy-cli exec vitest run \
    --config /tmp/happy-t2rt-xr-v6/vitest.config.mjs --configLoader runner \
    /tmp/happy-t2rt-xr-v6/adversarial.test.ts /tmp/happy-t2rt-xr-v5/adversarial.test.ts \
    -t '^(?!.*scanner-legacy-no-status)' --maxWorkers 2
  ```

- Final standard related suite: **10 files / 632 tests passed**. Channel ordering
  passed **271/271**, including all existing 65 cases (24 T2RT-07, four T2RT-08,
  four T2RT-09 and both T2RT-10 cases), **192/192 matrix cases** with no stale
  channel delivery in any replay, the four valid first-terminal legacy controls,
  four real-scanner finding regressions and six generation/task-scope checks.
  The matrix exercises 96 SDK cells and 96 real JSONL scanner cells, both initial
  proof decisions and newer-launch stale replays followed by exact-run recovery.
  No direct tracker mutation or evidence rearm is used as a test stimulus.
- Selection is the same ten files listed in round 5, run from the clone root
  with `corepack pnpm -C packages/happy-cli exec vitest run --project unit
  <files> --maxWorkers 2`. Final standard global setup passed CLI `tsc --noEmit`,
  pkgroll and extension-copy build. A separate CLI `typecheck` also passed during
  implementation; the final build rechecked the completed change.
- `git diff --check` passed. Existing bin-location/empty-chunk build warnings and
  asynchronously-handled-rejection harness warnings remain. No final related test
  failed and no Unix-socket EPERM occurred in the selection. No whole-suite,
  live-provider, Desktop-app or packaged-release acceptance is claimed. Delivery
  is a new behavioral commit directly above the review base and a normal push
  to the existing branch; no PR or history rewrite.

## Round 8: T2RT-13 disables routing after any history loss (2026-10-25)

Review base: `3d89d5c94671cdecdad1c03ca50afadacff9d03b`. T2RT-11/12 remain
closed. The user accepts exclusion of the no-status positive control: review
verified that it is not a production completion shape in Claude Code 2.1.299.

User-approved rule: **history loss ⇒ no channel routing for the rest of the
session; availability limit accepted by the user for zero wrong delivery**.
This supersedes every earlier exact-launch recovery after eviction. A matching
task/run, replayed `task_started`, current tool membership or reconstructed launch
owner cannot restore permission to route after the loss flag is set.

Implementation (Core, within the existing runtime boundary):

1. Reproduce T2RT-13 through the SDK pipeline and real scanner files, retaining
   the no-eviction controls. Add first-eviction and independent launch-only loss
   regressions without direct state mutation or rearm stimuli.
2. Keep one irreversible runtime loss flag shared by completion and launch
   retention. Check it before duplicate/proof shortcuts and after observations
   that may cause the first loss. Refuse with incomplete coverage, empty source
   IDs and `background-request-unrouted`; file diagnostics use `history-lost`.
   Preserve retained launch/source mappings. Do not record new launch ownership
   or rebind replayed starts/results after loss.
3. Increase completion and launch retention from 200 to **1000 records each**,
   keeping their 4096-byte identity/record bounds. Increase the corresponding
   alias budget from 400 to **2000 keys** (task/tool pairs). Any eviction or
   oversized identity/launch drops routing availability for this runtime.
   Foreground turn permission membership and witness-source budgets are separate.
4. Leave the pre-loss default-deny proof unchanged. Update post-loss expectations
   to refusal and preserve >cap bound reproductions. Remove obsolete post-loss
   recovery paths while retaining pre-loss run/alias handling.
5. Run related standard tests and type/build checks, record changed expectations,
   commit directly above the review base and push the existing branch normally.

Revisit only with a newly approved contract that proves generation-specific,
non-replayable launch ownership and completion identity independently of lost
bounded history, verified through SDK and real-scanner adversarial tests. Larger
caps or reconstructed state alone are not grounds to lift this limit. Starting a
new runtime creates a new session-local tracker; no in-session reset is provided.
Rollback is a revert of this behavioral commit. Only the tracker, mapper, existing
channel ordering tests and this report change; no public API/schema, dependency,
authority, UI, Desktop or T1b changes, and no new files.

Changed expectations in the existing 271 channel cases:

- The 96 `history=lost` matrix cells no longer route an exact candidate, recover
  channel-A, or recover a subsequently launched channel-B. Intact-history cells
  retain their existing proof/routing assertions.
- The three post-loss T2RT-11 malformed-status cases no longer recover channel-A
  via the exact current run; the no-loss T2RT-12 tool-alias control still does.
- Both T2RT-10 cases preserve the surviving run-2 mapping but refuse its exact
  completion after loss. They now require the `history-lost` diagnostic.
- All six `666faa96` recovery variants now refuse routing and assert that starts
  and results after loss cannot reconstruct a launch owner, including exact runs
  and both start/result orders. Obsolete post-loss root-recovery assertions and
  their unused snapshot were removed. Pre-loss `sameRun`/legacy proof and the
  incomplete-evidence reason for ambiguous pre-loss observations remain live.
- Both launch-retention stress cases refuse every sampled completion, including
  the exact retained latest run, without consuming any surviving launch mapping.
- The four T2RT-09 bound cases now process 1005 completions (>1000), asserting at
  most 1000 completion records / 2000 aliases. Launch stress also uses 1005 starts
  and asserts the 1000 launch limit. Existing foreground channel membership is
  preserved; refusing a background rearm does not detach an active foreground turn.

Verification:

- Original external T2RT-13 reproduction on the unchanged review base: **2 failed /
  2 passed**, with two unrelated exploratory tests excluded. The SDK and real
  scanner post-eviction stale answers both reached channel-B. Repository TDD red:
  **6 failed / 2 passed**, including both no-eviction controls passing.
- Final external reproduction adapted solely for the new retention boundary:
  **4/4 selected passed** (two unrelated exploratory cases excluded). The copy
  `/tmp/happy-t2rt-xr-v7/cap1000.test.ts` changes overflow from 205 to 1005, asserts
  `historyLost=true` after overflow, and allows 30 seconds for the longer fixture.
  Both actual Desktop tracker outcomes are `[]` after loss and no old/new launch
  owner is reconstructed. The unchanged 205-event harness also passes 4/4, but
  now exercises pre-loss history; it is not claimed as evidence of eviction.
  Command: `corepack pnpm -C packages/happy-cli exec vitest run --config
  /tmp/happy-t2rt-xr-v7/vitest.config.mjs --configLoader runner
  /tmp/happy-t2rt-xr-v7/cap1000.test.ts -t 'does not rebind' --maxWorkers 2`.
- Ten new repository cases cover SDK/file-scanner replay with/without loss, the
  first eviction in `task_started`, the completion that causes the first eviction,
  all receipt status/identity classes after that boundary, and launch-only loss
  with zero completion records. The 1000th-slot normal completion still routes;
  the 1001st identity cannot restore routing, including via replayed starts.
- Final standard related suite: **10 files / 642 tests passed**, including all
  **281 channel ordering cases** (the existing 271 with the approved expectation
  changes and ten new cases). All 192 matrix cells pass; all 96 lost-history cells
  refuse current/reconstructed exact-run recovery, while intact-history proof
  and the four genuine first-legacy controls retain their existing behavior.
  T2RT-07's 24 cases and T2RT-08's four cases remain unchanged and green.
- Selection is the same ten files listed in round 5, run from the clone root:
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit <files>
  --maxWorkers 2`. Standard global setup passed CLI `tsc --noEmit`, pkgroll and
  extension-copy build against the final production change.
- `git diff --check` passed. Existing bin-location/empty-chunk build warnings and
  asynchronously-handled-rejection harness warnings remain. No final related test
  failed and no Unix-socket EPERM occurred in this selection. No whole-suite,
  paid-provider, Desktop-app or packaged-release acceptance is claimed. Delivery
  is a new behavioral commit directly above the review base with a normal push
  to the existing branch; no new PR, rebase or history rewrite.

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

Historical status before the 2026-10-26 rescope: T2rt implementation and scoped
verification complete (2026-10-25).
The requested branch is `feat/rn-t2rt-input-evidence`, based on origin/main
`9ee84191cf6e6b2739987be3f5488ef511c6474f`. The independent working clone is
`/home/walter/workspace/aplus-dev-studio-desktop/.aplus/worktrees/rn-ext/happy-t2rt`.
The coordinating session owns fixed-SHA cross-review, PR creation, downstream
Desktop schema/reducer integration (T1/T2), and packaged runtime acceptance (T2r).


## Rescope on top of 678863db (2026-10-26)

Core, within the existing session runtime: no schema, dependency, authority or UI
change. Routing and evidence have separate maps and entry points. Existing
routing functions were diffed against `9ee84191`; only evidence hooks remain.
The non-channel final-answer path initially used an explicit mapper evidence
opt-in. T2RT-16 below supersedes it: the production opt-in still changed routing
state despite preserving the default mapper tests.

Tests removed/reworked: the T2RT-07 duplicate routing matrix, T2RT-08 resumed-run
routing assertions, T2RT-09 routing refusal, T2RT-10/11/12 default-deny/status/alias
routing matrix, T2RT-13 history-loss/recovery routing assertions and launch-map
routing stress expectations. These no longer define #951's behavior. Retained
or rewritten evidence coverage includes all 24 T2RT-07 SDK/scanner ordering
variants with their routing assertions removed, T2RT-02/03 active/pending/idle delivery
and witness eviction, identity/status uncertainty, bounded history, actual scanner
metadata from both locations, SDK observation without routing, consumed-scanner
positive proof and the two reviewer risk classes with incomplete evidence.
Two actual scanner cases have an explicit 15-second timeout for polling under load.

`channelTurnOrdering.mainCompatibility.test.ts` is the **byte-for-byte**
`9ee84191` channel suite (15 cases). `sessionProtocolMapper.test.ts` is restored
byte-for-byte to that base (50 cases), including its missing-status routing
fixtures. Both run unchanged against the additive implementation.

### Out-of-scope main risks

Both classes reproduce on the actual `9ee84191` mapper, loaded from a temporary
full source copy without switching branches. Two probes assert the observed
misattribution and passed **2/2**; these are reproductions, not fixes:

- **T2RT-14 class / restart reset:** discard the old runtime mapper after A's
  launch, create a fresh mapper and launch the same task for B, then deliver A's
  old consumed scanner row. The follow-up is stamped `requestId=channel-B`.
  Main has no T2rt history-loss latch to persist; its task/request map is local
  to the mapper. Durable restart/generation ownership is a separate follow-up.
- **T2RT-15 class / old-run/new-owner mix:** A launches the task, then B resumes
  the same task/tool without its own observed start; A's old explicit-run
  scanner completion takes B's task mapping. The follow-up is stamped
  `requestId=channel-B`. Main's routing map does not track provider run identity.
  Generation-aware routing is a separate follow-up.

These are scanner-path reproductions. SDK notifications are filtered out of
main's production routing stream, and remain evidence-only in #951. The retained
regressions explicitly preserve those routing outcomes while requiring incomplete
evidence for the ambiguous background input.

Validation before merge: 8 files / 174 tests passed, including the 2 baseline
risk probes, both unchanged compatibility suites, channel evidence, evidence state
and all three remote-launcher suites. Standard global setup passed typecheck,
pkgroll and extension-copy build. An earlier baseline check exposed ordinary
non-channel final publication changing main's default; the explicit evidence
opt-in corrected it. Final rescope selection, including the extra scanner-staging regression: **4 files /
141 tests passed**; standard typecheck/build passed again. `git diff --check` passed.

## Regular main merge and personal-fallback integration (2026-10-26)

Final merge target: `19aa650ee001efa5198b7c6f1c51d67e10c7b38f` (`origin/main`). Main advanced after the first
validation against `0aac5971`; the uncommitted merge was restarted on the latest
main with all four local change files preserved byte-for-byte. The committed
rescope and all existing history remain unchanged.
Resolve the two conflict files by retaining both import groups, main's
organization-authentication reset before T2rt's replacement cancellation,
`PersonalClaudeRecheckRequired` before the account-refusal flush/close, and both
cleanup paths. No dependency versions or lockfile changed (the CLI version and a
development script changed upstream), so no dependency reinstall is needed.

The trial resolution reproduced **7 five-second timeouts / 10 passes**. The
cause is T2rt's added `await messageQueue.flush()` before main saved `lastTurnMode`:
consent arrives while output is draining, sees a null mode despite a refused
result, and schedules no continuation. Save the mode synchronously before the
flush; no timeout increase. With that correction all seven original scenarios
pass. The expanded tests run the same scenarios with and without real witness
state and assert the continued original REST identity/root.

Additional evidence integration reproductions:

- An organization authentication failure may lead to approved personal
  continuation without an organization quota refusal. The expanded suite was
  **23 passed / 1 failed**: only that evidence-enabled scenario lost its root
  and became unidentified. Retain an account-switch witness for this existing
  personal-fallback flow, without changing when main permits continuation.
- Consent during an in-flight organization rebind cancels the organization wait.
  T2rt's old cancellation check then cancelled the already-selected personal
  continuation's witness. The focused reproduction was **1 passed / 1 failed**
  (24 skipped); the evidence-disabled main behavior passed. Preserve the witness
  when a continuation has already been selected. This regression uses a held
  rebind promise, without artificial timeout extensions.

First merged related CLI validation (`0aac5971`): **41 files / 1095 tests: 1093 passed, 2 environmental
failures**. All **26 setup-token/personal-fallback cases** passed, including the
seven original main scenarios, their witness-enabled variants and consent during
an in-flight rebind. All channel, mapper, input-evidence, API session, managed
startup and other launcher cases in the selection passed. Standard global setup
passed CLI typecheck, pkgroll and extension-copy build.

The two failures are the real-supervisor cases in
`daemon/launch/managedLauncherBoot.test.ts`: before opening their Unix sockets,
`assertTrustedRoot` rejects `/tmp`'s sandbox owner (UID 65534; process UID 1000).
Both that test file and `launcher/generationManifest.ts` are unchanged from
`9ee84191` and `origin/main`. This is an environmental ownership failure, not an
observed socket EPERM, and is not counted as a pass. No security check, filesystem
ownership or test assertion was changed to bypass it. The other four managed
startup files and `managedLauncherBinding.test.ts` passed.

Selection (all under `packages/happy-cli`, expanded to individual `src/...`
arguments before calling `corepack pnpm -C packages/happy-cli exec vitest run
--project unit <files> --maxWorkers 2`): all `src/channel/*.test.ts`,
`src/claude/*Launcher*.test.ts`, `src/managed/*Startup*.test.ts` and
`src/daemon/launch/managedLauncher*.test.ts`, plus:

```text
src/api/{apiSession,automationTurnTracker,turnInputEvidence,types}.test.ts
src/claude/{claudeContextUsage,claudeRemote,personalClaudeCredential,personalClaudeFallback,runClaude,runClaudeOfflineAck,setupTokenAccountSwitching}.test.ts
src/claude/utils/{permissionHandler,sdkToLogConverter,sessionProtocolMapper,sessionScanner}.test.ts
src/codex/{codexAppServerClient,runCodex.capacityRetry}.test.ts
src/codex/{utils,__tests__}/sessionProtocolMapper.test.ts
src/utils/MessageQueue2.test.ts
```

Wire build/typecheck and **39/39** wire schema tests passed. A separate final CLI
typecheck passed. `git diff --check` passed. Existing empty-chunk/bin-location
build warnings and listener/asynchronously-handled-rejection harness warnings
remain. No whole-suite, paid-provider, Desktop or packaged runtime acceptance is
claimed. No other branch, PR creation, rebase, force-push, tag or release action
is part of this delivery.


Final review also retains the full 24-case reviewer evidence ordering matrix
(both delivery orders, four run-metadata combinations and follow-up/idle/unrelated
arrival phases). Its superseded routing assertions are removed: SDK observation
is incomplete unless consumption was already witnessed, exact SDK duplicates of
consumed scanner input do not contaminate unrelated evidence, and scanner closure
continues to follow main. Twelve scanner status/run proof cases mirror the SDK
uncertainty matrix without changing main routing. Final focused validation of
these retained cases and the unchanged compatibility suites passed **4 files /
177 tests**, including all 24 ordering cases and 12 scanner proof cases.

Latest-main final related validation: **41 files / 1171 tests passed**, including
all **82 channel ordering/evidence cases**, all **26 personal/account-switch
cases**, the unchanged **15 channel / 50 mapper compatibility cases**, and the
Codex permission-handler consumer affected by latest main. Standard global setup
again passed CLI typecheck, pkgroll and extension-copy build. The selection is the
first merged selection above with the known environmental boot suite removed and
`src/codex/__tests__/permissionHandler.test.ts` added. The two earlier boot failures
remain reported separately, not counted as passes or repeated without a changed
environment; both test and manifest check remain unchanged. No socket EPERM was
observed in this final selection. `git diff --check` passed. Delivery is the
rescope commit followed by one regular latest-main merge and a normal push to
`feat/rn-t2rt-input-evidence`.


## T2RT-16: independent textless witness lifecycle (2026-10-26)

Review base: `26a93cf14862d338f4fb887d0d20cb40e63d9026`. The medium routing-parity
finding is accepted. Calling the mapper with `includeInputEvidenceFinal=true`
opened an uncorrelated routing turn before `onReady`, including when evidence
capability was disabled. A real scanner attachment then found that turn active,
consumed the background request map without rearming A, and left the terminal
without `requestId=channel-A`. `ensureClaudeInputEvidence` also entered the same
routing mapper and could consume a waiting channel request during preparation.

TDD first added a real `ApiSessionClient` + real `createSessionScanner` JSONL
attachment regression in `api/apiSession.test.ts`, for both capability states.
Before production changes: **2 failed / 159 skipped**, reproducing routing-state
mutation, failed scanner rearm and lost terminal correlation on the review base.
No mapper mock or direct rearm callback is used as the stimulus. The test verifies
the task/tool map remains intact until scanner consumption and that only the
scanner rearms A. Its 15-second timeout accommodates actual filesystem polling.

Correction (Core, within the existing session host and wire contract):

- Remove the routing mapper's evidence opt-in and `startClaudeInputTurn` export.
  `mapClaudeChannelFinalAnswer`, the notification parser, request-map insertion
  and rearm helpers now match `9ee84191` byte for byte. Normal routing activity,
  channel final publication and native failure/terminal behavior remain owned by
  that mapper.
- Keep textless start/final/end entirely in `TurnInputEvidence`. The witness uses
  its own turn ID and never receives the routing state or request maps. The API
  publishes these events only when evidence capability is enabled. A current
  mapped turn may receive a final witness without changing its routing state.
- Evidence preparation and retry carry use that independent lifecycle too.
  Ordinary textless completion closes only its witness; a scanner-rearmed
  channel terminal follows main's routing lifecycle separately. Both the unmapped
  witness and any following background witness remain incomplete when consumption
  is ambiguous. Late mapped activity settles both witnesses conservatively with
  `witness-turn-interleaved`, rather than leaving the first witness live.
- Update the existing channel/fallback test doubles to use the same independent
  witness lifecycle. Retain all their evidence assertions, including retry roots
  and the 24 SDK/scanner ordering cases.

Six additional real-client cases cover textless REST identity and repeated finals
in both capability states, preparation with a pending channel in both states,
textless transient retry root preservation, and late mapped output. Every emitted
frame in the real-scanner and textless-final cases is checked against the wire
schema. No schema, dependency, authority, routing-policy or unrelated file changes
are introduced. No new files are needed. Revisit this separation only if routing
and witness turn identity gain an explicitly approved common lifecycle contract.
Rollback is a revert of this follow-up commit; it would reintroduce T2RT-16.

Verification so far:

- Repository TDD: **2 failed before / 2 passed after** for the actual scanner
  reproduction, with both capability states covered.
- Reviewer's unchanged `/tmp/happy-t2rt-xr-v9/api-routing.test.ts`: **2/2** against
  the extracted `9ee84191` source and **2/2** against the fix. The reviewer's
  existing head log records the corresponding failures on `26a93cf1`.
- Focused standard suite: **8 files / 394 tests passed**, including all eight new
  API cases, the complete channel/evidence matrix, mapper/scanner, evidence state,
  and transient/personal account-switch suites. Standard global setup passed CLI
  typecheck, pkgroll and extension-copy build.
- Reviewer's unchanged compatibility selection: **8 files / 241 tests passed**,
  including the extracted merge-base channel/mapper/scanner tests and main's
  personal-fallback suite. Its config intentionally has no global build setup;
  the separate standard runs provide that check.
- Final standard related suite: **43 files / 1203 tests passed**. This is the
  prior latest-main 41-file selection plus `codex/__tests__/codexUserInput.test.ts`
  and `codex/codexSteerHandler.test.ts`. It covers all launcher/channel/mapper,
  API/evidence/automation, permissions, queues, managed startup and related Codex
  consumers, including the eight new API regressions. Standard global setup
  passed CLI typecheck, pkgroll and extension-copy build against the final code.
- `git diff --check` passed. No Unix-socket EPERM or other test failure occurred
  in the final selection. The unchanged boot suite's previously documented
  sandbox ownership failure was not repeated. Existing bin/empty-chunk and test
  listener/asynchronous-rejection warnings remain.
- No whole-suite, live-provider, Desktop, packaged-release or new routing-hardening
  claim is made.

Standard CLI commands run from the clone root use `corepack pnpm -C
packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
Reviewer reproduction commands use the same prefix with `--config
/tmp/happy-t2rt-xr-v9/{base.config,vitest.config}.mjs`, `--project unit`, the absolute
`api-routing.test.ts` path and `--maxWorkers 2`. No rebase, main merge, force-push,
new PR, tag, publication or other-branch mutation is part of this follow-up.
