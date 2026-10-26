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

The T2RT-19 structural decision below also makes **wire turn lifecycle identical
to `9ee84191`**: T2rt cannot create, close or reorder turn-start/turn-end events.
The separate unmapped lifecycle from `02497601`, `e68bed17` and `f93aeae0` is
removed. Only native mapped turns can stamp finals or supply retry roots.
With input-evidence capability enabled, an unmapped final publishes a terminal,
incomplete `turn-input-evidence` revision
without an envelope `turn`; its payload ID is only an evidence correlation token.
It has empty inputs, no consumed-input claim and no eligibility for a later final.
Automation/follow-up behavior remains main's, including the pre-existing missing
textless automation completion and notification/intervention cases reproduced below.

**Desktop T2 enablement prerequisite:** “exclude turn-input-evidence/hub-input-admission
from response activity and hydration; add an encrypted-history regression”. This
is a hard prerequisite before Desktop opts in to the capability. No extra native end may compensate for
an incompatible consumer. Capability-disabled sessions publish neither evidence
revisions (standalone or mapped) nor admission metadata, including late callbacks.

**Hard T2 caller prerequisite (T2RT-33):** guarded delivery requires a live,
evidence-ON runtime check using a fresh matching contact/epoch and ON marker,
plus a bounded admission-receipt timeout. Cached metadata or message storage
alone cannot establish delivery; absent receipt means not delivered. An OFF
runtime never executes guarded prompts. The detailed requirement is recorded
with T2RT-21 in [the capability-gate prerequisites](#t2rt-2022-refusal-parity-capability-gate-and-missing-retry-settlement).

Production-source check at Desktop `d58812b75e41f384d0c5242b011249fea074efea`:
`config/happy-runtime-pin.json` pins CLI `1.1.10-aplus.357` / `9ee84191`, which
does not implement this capability. No Desktop opt-in was found in `src`, `cli`,
`config` or `scripts`. This is a source/pin check, not a live fleet assertion.
At `c7b4f8c2` the Claude/Codex launchers still enabled evidence automatically;
T2RT-23 replaces that behavior with the default-off launch contract below.
Upgrading a runtime pin alone no longer enables evidence. Desktop's
generic `messageContentHasAgentResponseActivity`, `apiMessagesResponseLifecycle`
and raw-history hydration readers currently misclassify these metadata events.
The earlier v12 consumer check below covered narrower parser/wait paths and
does **not** establish compatibility for those generic readers.

### T2 hand-off: explicit consumer opt-in

The per-session launch option is `environmentVariables.HAPPY_INPUT_EVIDENCE`
in a daemon spawn/resume request: only the strings `"1"` (ON) and `"0"` (OFF)
are admitted; invalid request values are rejected before spawn. An unrelated
new session with no option is OFF. A direct CLI launch can supply the same env
seed; only literal `1` enables it, with other supplied values failing closed.
Daemon and new-session environment sanitization remove implicit inheritance,
including a daemon auto-start/restart from an opted-in CLI process.

Each runner consumes the explicit seed **once before startup awaits**, then
resolves it against only its own reconnect snapshot. The captured boolean drives
initial configuration, Codex replacement-session configuration, final candidates
and empty plans; later changes to `process.env` cannot change it. The daemon
captures the validated `0`/`1` alongside that session's existing resume state and
restores it after restart. A resume request's explicit setting overrides its own
saved value. ON also records `metadata.inputEvidenceEnabled=true` for same-session
recovery when no tracked environment survives; explicit OFF removes that marker.
Live hosts do not repair dropped evidence/contact markers on observation or
ordinary metadata writes. OFF mode transitions never publish metadata, even
after incoming documents with an ON marker or a stale/foreign contact. **Residual for installed old app
versions:** editing a session's metadata can erase the recovery marker, including
while a host is live. If no validated saved session
environment survives, later metadata-only recovery is OFF. This never enables
evidence incorrectly; a validated saved value or explicit request still wins.

Fresh OFF sessions add no setting metadata. Standalone `happy resume <id>`
restores only the evidence setting from the resolved original Happy ID (validated
saved `0`/`1`, then original server metadata). `--input-evidence 0|1` explicitly
overrides it; the caller's `HAPPY_INPUT_EVIDENCE` is scrubbed and never used as
that override. ACP remains unsupported.
The session host advertises `agentContact.inputEvidence=1` only when enabled
and otherwise eligible under the existing account/remote-mode checks. The API
publication gate suppresses all evidence/admission envelopes while OFF, and
does not add or delete `agentContact`: ordinary OFF mode transitions preserve
main's metadata under every incoming document. Received advertisements never
enable this host's evidence or guarded-input capability. All guarded input is
refused while OFF, including matching, malformed and stale guards; no guard is
ever stripped to execute its prompt as unguarded input. No guard/admission
contract is advertised in that mode. Unguarded input retains main's behavior.

ON advertises `guardedPrompt:1` only together with enabled admission publication.
Matching guards receive a server-message-ID-bound accepted receipt at admission;
malformed/stale/mode-invalid guards receive rejected receipts. Mode changes
invalidate queued guarded input and publish its rejection while ON. The existing
principal, runtime, session ID and mode/epoch checks continue to apply.

The **Desktop T2 launching integration** owns setting this value for a session
whose readers support the new envelopes, after completing the hard prerequisite
above: exclude `turn-input-evidence`/`hub-input-admission` from response activity
and hydration, and add an encrypted-history regression after a completed turn.
Desktop has not been changed to set it in this PR. Other explicit consumer-owned
launches can opt in under the same compatibility contract; do not set a
machine-wide/daemon-wide export as a substitute for consumer readiness. Installed
older happy-agent or other clients therefore receive main-compatible output by
default, independent of a runtime pin. A newer happy-agent also ignores both
metadata kinds before updating either completion-wait activity flag.

This flag authorizes evidence publication only. It does not create native turns,
route channels or grant provider/session authority. Disable the flag on the next
launch to return to the default publication behavior; native lifecycle remains
main's in either state.

## Scope and architecture

Core: authoritative runtime input consumption, host mode transitions and permission
membership belong to the session host. No Extension, new dependency, credential,
owner authority, server schema or provider protocol is introduced.

The input witness is independent of routing `requestIds`, the channel `requestId`
slot and `AutomationTurnTracker`. Original queue entries retain text/attachments
locally for revalidation; only identifiers, counters and states enter evidence.
Automation retains main's single-run arming/carry semantics and native retry
flags. Evidence revisions cannot carry, abandon or settle automation runs.

Only the independent Happy clone is edited. The user's T2RT-26 request now
authorizes narrow option validation/capture in `daemon/sessionEnv.ts` and child
env scrubbing; credential policy in that file is unchanged. `daemon/run.ts`,
`commands/sessionAgentBroker.ts` and T4o's ownership/export files remain excluded.
`sessionProtocol.ts` is T2rt-owned and already exported by the
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

## T2RT-17: settle unmapped witnesses at consumed scanner boundaries (2026-10-26)

Review base: `02497601dd5ee9cd652839b44d4e14092f988538`. The evidence-only medium
finding is accepted. A textless successful result can leave its independent
witness open while `claudeRemote` waits for background work before `onReady`.
A consumed scanner notification stages the next background evidence batch,
but the routing mapper has no turn to close. The old witness then intercepted
the textless follow-up final and falsely retained A's complete input attribution.

TDD used the reviewer's unchanged real-loop `lifecycle-proof.test.ts` first:
**1 failed / 3 passed** on the review base. The consumed scanner row plus
textless follow-up retained A's complete witness; attachment receipt, SDK receipt
and consumed row plus mapped assistant were the three passing controls.
The durable regression is `api/apiSession.inputEvidenceLifecycle.test.ts`.
It preserves all four scenarios and uses the real `claudeRemote`, converter,
ordered dispatcher, outgoing queue, API client and JSONL scanner. Only the SDK
and network boundaries are scripted. It additionally checks settlement at the
consumption boundary before either form of follow-up output, a published terminal
incomplete witness without a synthetic `turn-end`, separate follow-up turn/root
identity, empty unproven inputs, exactly one eventual `onReady`, and wire validity.
Those stronger immediate-settlement assertions failed for both consumed-row
variants before the production fix (**2 failed / 2 passed**).

Correction (Core, internal to the existing evidence tracker): a consumed scanner
boundary settles any independent unmapped witness with background incomplete
reasons and publishes its terminal evidence revision. Pending/running witness
continuations are cancelled, and its retry carry and active witness identity are
released. The staged background batch remains available for the follow-up's own
witness. Unknown launch/consumption proof therefore yields empty inputs and
incomplete coverage with background reasons, for both its final and terminal.
Receipt-only attachment/SDK observations keep their existing conservative
co-consumption behavior. Mapped turn settlement remains the mapper's responsibility.

This transition emits only evidence; it does not emit a routing terminal or
modify channel state, task/tool request maps, the API client, the mapper or ordered
dispatch. The four routing helpers remain byte-identical to `9ee84191`.
No dependency, schema, public API or authority change is introduced. Revisit
only if the provider supplies a stronger lifecycle/consumption proof. Rollback is
a revert of this follow-up commit, which would reintroduce T2RT-17.

Verification:

- Reviewer's unchanged lifecycle reproduction: **4/4 passed** after the fix.
- Same unchanged reproduction on extracted `26a93cf1`: **4/4 passed**.
- Repository lifecycle regression: **4/4 passed** after the fix.
- Related standard suite: **44 files / 1207 tests passed**. This is the previous
  43-file related selection plus the new lifecycle regression, covering launcher,
  fallback, channel, merge-base compatibility, mapper/scanner, API/evidence,
  automation, Codex consumers and managed startup.
- Standard global setup passed CLI typecheck, pkgroll and extension-copy build.
  Routing helper byte parity and `git diff --check` passed. No Unix-socket EPERM
  or test failure occurred. Existing bin/empty-chunk and listener/asynchronous
  rejection warnings remain. The previously documented unrelated boot suite
  ownership failure was not repeated; no whole-suite or live-provider claim is made.

The reviewer reproduction uses `corepack pnpm -C packages/happy-cli exec vitest
run --config /tmp/happy-t2rt-xr-v10/vitest.config.mjs --project unit
/tmp/happy-t2rt-xr-v10/lifecycle-proof.test.ts --maxWorkers 2` from the clone root.
The durable suite uses the standard unit command documented above.

## T2RT-18: balance witness events for existing consumers (2026-10-26)

Review base: `e68bed17d990f8ab6445efedffa51aa77ab9379d`. The medium finding is
accepted. T2RT-17 closed the evidence snapshot but omitted the matching witness
`turn-end`. `AutomationTurnTracker` had already observed W's `turn-start`, so its
active scheduled run could never settle after the witness pointer was cleared.
Terminal evidence alone does not complete the existing envelope lifecycle.

TDD first ran the reviewer's unchanged `automation-settlement.test.ts`:
**1 failed / 3 passed** on the review base. Evidence-on plus a consumed scanner
row during awaited `afterTurn` produced no automation completion report. The
evidence-off and no-boundary controls passed. The same unchanged matrix passes
**4/4** on extracted `02497601`. The repository regression extends the existing
`api/apiSession.inputEvidenceLifecycle.test.ts`, with the actual encrypted socket
update that arms a scheduled run, real remote loop/ordered queue/API/tracker and
real scanner JSONL delivery during `afterTurn`. Only SDK/network boundaries are
scripted. Its stronger settlement assertions reproduced **3 failures / 5 passes**
before the production fix: missing completion plus both missing consumed-boundary
witness ends. T2RT-17's assertion forbidding any witness end was incorrect; it is
replaced by exactly one non-routing end for the same witness ID.

Correction: after conservatively settling W's evidence and releasing its active
identity, emit W's matching `turn-end(status=completed)` through the existing
evidence emitter and `ApiSessionClient.sendSessionProtocolMessage`. It carries
no channel `requestId` and does not enter the routing mapper. All normal envelope
consumers receive it. Later `onReady` finds no W pointer and emits no duplicate.
The staged background evidence and T2RT-17's separate incomplete follow-up
attribution are retained. This is an internal Core lifecycle correction; no
schema, dependency, API, authority or routing-policy change is introduced.

### Whole-package consumer audit (completed before commit)

Searched the entire CLI package with `rg -n --hidden 'turn-start|turn-end|turnStart|turnEnd'
packages/happy-cli`, excluding dependency/build directories, then inspected the
event consumers and `SessionEnvelope`/`ev.t` publication paths. The broader
case-insensitive search also checked timestamp/counter and provider lifecycle
references. These are all consumers reachable by a Claude witness pair:

| Consumer | Settlement path and balance confirmation |
| --- | --- |
| `api/turnInputEvidence.ts`: `TurnInputEvidence.stamp` | API stamps W's start and matching end; end retains terminal/incomplete evidence. Active W is already released, so it cannot intercept F or close twice. Actual-loop tests assert terminal state, separate F identity and one end per emitted start. |
| `api/automationTurnTracker.ts`: `AutomationTurnTracker.observe`, via `ApiSessionClient.applySessionProtocolRuntimeSideEffects` | Both W events use the same API sink. The active run is cleared by W's matching end; the real encrypted scheduled-prompt matrix asserts exactly one `notifyDaemonAutomationTurnResult` with the parent's completed/null-answer result, including before `onReady` in the scanner case. |
| `api/apiSession.ts`: `enqueueSessionProtocolEnvelope` and remaining runtime side effects | Start consumes the pending evidence flag; matching end reaches the existing tool/AskUserQuestion cleanup and retry/report logic once. Existing API, automation and launcher regressions exercise these consumers. No new routing call or channel state mutation is added. |
| `api/apiSession.ts`: `enqueueMessage`/`flushOutbox` transport | Both events enter the same ordered encrypted session-message outbox; neither event type is filtered. Captured output has exactly one matching start/end and valid wire envelopes. Outgoing network/storage remains a mocked boundary in the regression. |
| `daemon/automations/sessionFollowupRunner.ts`: `observeFollowupTurn` | Persisted session envelopes now contain W's end as well as its start. The new matrix replays the actual emitted envelopes through this observer and asserts `complete=true`, `failed=false`. |
| `browserRuntime/e2e/realAgentHarness.ts`: `transcript`/`waitForTranscript`, used by `realAgentA01.ts`, `realAgentA01DesktopGui.ts`, `realAgentA08.ts`, `realAgentSandbox.ts`, `realAgentSandboxProd.ts` | Transcript normalization retains event type/time; these scripts wait for `turn-end` and now receive the end from the balanced published pair. They do not correlate turn IDs. Source path audited against the emitted sequence; live browser/agent scripts were not run. |
| `testing/sessionWriteScopeFixture.ts`: `waitReply` | Reads stored session events and waits for a later `turn-end`; the common outbox now supplies both events. Source path audited against the balanced emitted sequence; its separate server integration fixture was not run. |

Other matches are not subscribers to Claude witness envelopes:
`agent/acp/runAcp.ts` formats its own ACP manager's events before sending them;
`codex/runCodex.ts` inspects its own provider mapper's events before API dispatch.
Claude/Codex/ACP mappers and channel/launcher helpers produce lifecycle events,
not consume witness emissions. `openclaw/runOpenClaw.ts` forwards ACP events.
Daemon idle reaper/runtime receipts consume derived thinking/tool/timestamp
reports, not these envelopes. Prompt text, test assertions and permission reset
reason strings introduce no additional event consumer. No consumer is bypassed
by a special automation-only completion call.

Verification:

- Reviewer's unchanged automation reproduction: **4/4 passed** after the fix.
- Repository lifecycle tests: **8/8 passed**, including all four T2RT-17 controls.
  Every emitted turn-start has exactly one matching end. Capability-off remains
  unchanged; the no-boundary case still closes at `onReady`.
- The scheduled matrix checks mapper turn/request state, pending request and
  task/tool request maps before/after scanner delivery and after `onReady`.
- Routing parser, map insertion, rearm and final-answer helpers remain
  byte-identical to `9ee84191`; API client, mapper and channel ordering source
  remain unchanged from the review base.
- Reviewer's unchanged T2RT-17 lifecycle reproduction: **4/4 passed** after this
  fix, retaining all consumed-row/attachment/SDK/mapped-assistant controls.
- Related standard suite: **46 files / 1312 tests passed**. The previous 44-file
  selection now includes four additional scheduled-run cases, plus
  `daemon/automations/sessionFollowupRunner.test.ts` (44 tests) and
  `daemon/sessionIdleReaper.test.ts` (57 tests) for the audited consumers.
- Standard global setup passed CLI typecheck, pkgroll and extension-copy build.
  `git diff --check` passed. No Unix-socket EPERM or test failure occurred.
  Existing bin/empty-chunk and listener/asynchronous-rejection warnings remain.
  No whole-suite, live-provider, browser/Desktop or server integration claim is
  made; the unchanged boot-suite ownership issue documented earlier was not rerun.

Reproduction command from clone root: `corepack pnpm -C packages/happy-cli exec
vitest run --config /tmp/happy-t2rt-xr-v11/vitest.config.mjs --project unit
/tmp/happy-t2rt-xr-v11/automation-settlement.test.ts --maxWorkers 2` (substitute
`parent.config.mjs` for the `02497601` control). Standard repository commands are
unchanged. Revisit lifecycle handling only with a contract that accounts for all
these consumers; terminal evidence is not a substitute for the matching end.
Rollback is a revert of this follow-up, which would reintroduce T2RT-18.

## T2RT-19 structural correction: evidence never owns wire turns (2026-10-26)

Review base: `f93aeae0a07cbf4f48ff6ff28ec087beab646aa5`. The finding is accepted.
Three successive fixes to an independent wire-emitting witness caused attribution,
automation and follow-up regressions. The user's structural option supersedes the
T2RT-16/17/18 lifecycle design and its historical verification claims above.
The unchanged v12 follow-up reproduction initially reproduced **3 failures / 2
passing controls**. Fixing notification classification alone would still leave
T2rt owning turns, contrary to the standing scope decision.

Removed behavior:

| Commit | Removed behavior |
| --- | --- |
| `02497601` | `unmappedTurn`, synthetic witness start/final/end, API pending/ensure preparation state, synthetic retry preparation turns and mapped/unmapped interleaving settlement. Evidence can add a final to an already mapped native turn, but cannot create one. |
| `e68bed17` | Consumed-scanner settlement and rotation of the separate unmapped witness. No such live witness now exists to intercept F or retain A's attribution. |
| `f93aeae0` | Synchronous witness `turn-end` at scanner consumption and its extra automation completion report. Neither scanner request maps nor daemon follow-up interpretation is changed to accommodate invented turns. |

The package-wide audit also found the earlier T2RT-05 Codex `dispatchedInput`
mapper predicate synthesized turns for a written REST failure without a provider
start. That predicate is removed and its terminal branch restored to `9ee84191`.
The dispatch observation now supplies only an incomplete `provider-turn-unmapped`
revision; main's existing channel-request failure start/end remains intact.
The older API hooks that carried/abandoned automation from evidence are also
removed: its complete automation/tool runtime-side-effect method is restored
byte for byte to `9ee84191`. Only native events and main's retry flags settle runs.

`TurnInputEvidence` now constructs only evidence revisions, never turn-start/end.
An unmapped final produces `coverage=incomplete`, `inputs=[]`, `inputCount=0`,
`terminal=true` and `unmapped-final-answer`, plus any staged background reasons.
There is no envelope turn ID, registered turn snapshot, current/last witness or
retry carry for that revision. Its required payload identity is a fresh opaque
correlation token, not an invented routing turn. The pending unmapped batch is
discarded rather than stamping a later mapped final; an unmapped gap also clears
the previous mapped snapshot's default retry lookup. Explicit stored background
source snapshots remain available through their actual native IDs. Mapped
evidence, exact additional-input settlement and proven mapped retry roots stay.
Account/refusal tests now distinguish an observed authentication-error turn from
a textless refusal: only the former may preserve its witnessed retry root.

### Durable source parity and main reproductions

`api/apiSession.inputEvidenceLifecycle.test.ts` extracts CLI source from Git
`9ee84191` into a temporary directory and runs the same
`api/fixtures/turnEventParity.scenarios.ts` against that source and HEAD in
isolated Vitest projects. No stored hand-written baseline mapper or `/tmp`
review fixture is needed to run this regression. Both use the installed wire
codec and dependencies; SDK/network boundaries are scripted. Routing IDs and
envelope ID/time allocation are deterministic per native event kind so additive
evidence/final frames cannot shift the oracle's IDs. The comparison retains
turn/envelope IDs, role, request ID, status, order and count; only additive
`inputEvidence` payloads are excluded from the turn-frame comparison.

The **26 scenarios per revision / 52 source replays** include:

- T2RT-16's channel A launch/result/final/real scanner attachment/rearm, evidence
  off and on, with the real API client, converter and ordered queue.
- T2RT-17/19's held result with consumed row, attachment or SDK receipt; textless
  and mapped-review controls; and ordinary-session `afterTurn` consumption, all
  in both capability states. Actual emitted envelopes feed `observeFollowupTurn`
  and `runSessionFollowupTick`, including evaluate/deliver decisions.
- T2RT-18's encrypted scheduled-prompt socket update and real awaited
  `afterTurn`/scanner matrix, evidence off/on and boundary absent/present.
- All three v12 overlapping B/outbox cases in both capability states: an actual
  encrypted outbox POST is held while B opens, answers and receives the scanner
  observation; transmitted frames equal the queued frames without duplicate
  local IDs. Their turn sequences must equal main's.
- Codex no-provider-start termination with and without a waiting channel request.
- A mapped scheduled failure in both capability states, verifying completion
  report timing before evidence cancellation as well as the eventual result.
  This extra control first failed on evidence's automation carry hook; restoring
  main's runtime-side-effect method makes it pass.

The parity test failed before the structural correction (38 soft mismatches,
including extra turns, consumer decisions/reports and absent non-turn revisions)
and passes after it. It also checks standalone revisions are incomplete/empty,
that their IDs/roots never stamp native finals, and that mapped follow-up finals
cannot inherit A. A separate golden regression first failed on stale retry
lookup after an unmapped gap, then passed after that lookup was removed.

**T2RT-18 reproduces on `9ee84191`:** all four scheduled textless controls emit
zero wire turn events, call `onReady` once and send zero automation completion
reports. HEAD must do exactly that. The stranded scheduled run is pre-existing
and out of scope; T2rt cannot repair it by inventing a turn.

**Main also classifies the T2RT-19 consumed notification as intervention** when
there was no mapped turn open before it: both the held-result and ordinary
mapped-review controls return `userIntervened=true`, evaluate
`TERMINATE/USER_INTERVENTION` and deliver zero follow-ups on `9ee84191` and HEAD.
The attachment-with-no-native-turn control likewise reports intervention;
SDK receipt without a scanner user envelope waits. These are main behaviors,
not fixes claimed here. Notification identity/daemon follow-up hardening is a
separate out-of-scope follow-up under the user's parity requirement.

Verification:

- Durable parity: **26/26 scenarios match main**, **52 source replays passed**.
- Standard related selection: **46 files / 1305 tests passed**, including the
  source-parity orchestrator, API/evidence, all launcher/fallback/channel tests,
  unchanged merge-base routing compatibility, Codex consumers, daemon follow-up,
  idle reaper and managed startup. Nested source replays are counted separately
  above, not added to this Vitest parent-test total.
- CLI global setup passed typecheck, pkgroll and extension-copy build; final
  explicit CLI typecheck passed after the test-export addition.
- Adapted v12 external consumer replay: **6/6 passed** (all outbox sources,
  capability off/on, with baseline and HEAD emissions). Actual Desktop response
  lifecycle/parser/wait snapshot, channel final tracker, Happy App normalization
  and Happy Agent completion waits agree with main for the readers exercised.
  **Superseded compatibility scope:** v13 subsequently exposed the generic
  Desktop activity/hydration regression; the hard prerequisite above applies.
  The supplied artifacts' original synthetic-W expectations are intentionally
  superseded.
- Routing parser, insertion, rearm and final-answer helpers remain byte-identical
  to `9ee84191`; the merge-base routing test copies remain unchanged. Evidence
  source contains no construction of turn-start/end. `git diff --check` passed.
  No Unix-socket EPERM or failure occurred in the final related selection.
  Existing bin/empty-chunk and listener/asynchronous-rejection warnings remain.
  No whole-suite, live-provider or full Desktop application validation is claimed.

The fixture optionally exports observations with `T2RT_PARITY_EXPORT=<local path>`
for review tools; default runs remove their extracted sources and observations.
The T2RT-23 extension writes separate `<local path>.off.json` and
`<local path>.on.json` observations for the two opt-in modes.
CI's macOS full-unit checkout now fetches history so the pinned Git object exists;
the SDK-update job already does so. Standalone/shallow checkouts must also contain
`9ee84191` to run this test. No test performs an implicit network fetch.
Standard test commands remain unchanged. No dependency/schema change, PR,
rebase, force-push, main merge or other-branch mutation is introduced. Revisit
wire ownership only with a separately approved protocol/lifecycle design that
accounts for all consumers; terminal evidence must never acquire turn semantics.

## T2RT-20..22: refusal parity, capability gate and missing retry settlement

TDD on `b737fa36` first produced **6 failing tests / 223 passing tests**:
the source orchestrator exposed both extra exception-turn sequences, the disabled
capability test exposed four leaked metadata envelopes, all three retry kinds
failed post-write/pre-start settlement, and the real Codex loop retained its
pending root. Pre-write cancellation controls already passed. The reviewer's
real-runner receipt assertion independently reproduced the pending/nonterminal root.

- **T2RT-20:** remove the account-refusal exception branch's forced queue flush
  and failed native close. Queue only the continuation-evidence observation;
  main's existing finally flush and account-rebind ordering own the lifecycle.
  An exception recovery stays in the same native turn. A claimed continuation's
  next mapped text/tool/final can advance that existing witness to running; its
  native end then completes the same root, without an additional turn-start.
  The orchestrator now replays exception-before-result and result-message
  refusals with capability off/on against both `9ee84191` and HEAD. Exceptions
  have one completed turn; result-message refusals retain main's failed turn
  followed by a completed recovery turn. Both paths preserve the original input
  root when evidence is enabled. The same-root assertion first caught the
  still-pending same-native-turn receipt after restoring native parity.
- **T2RT-21:** the common API envelope publication boundary drops both
  `turn-input-evidence` and `hub-input-admission` while the session's evidence
  support is disabled. This covers direct sends, provider orphan snapshots,
  accepted/rejected admissions and late tracker callbacks after disablement.
  Admission validation still runs. Native start/end events are unaffected.
  The two-state regression includes metadata after a completed turn and checks
  no native boundary is suppressed or added. Production Desktop's pin/capability
  answer and the hard consumer prerequisite are recorded at the top of this
  report. The capability-on Desktop reader defect is intentionally deferred to
  that prerequisite; these CLI changes do not claim to fix Desktop hydration.

  **HARD Desktop T2 caller requirement (T2RT-33):** a guarded-prompt sender
  must not trust cached session metadata. Before sending, it must confirm that
  the target runtime is live and evidence-ON, for example through a fresh
  `agentContact` with the matching `runtimeId`/`modeEpoch`, `inputEvidence:1`
  and `guardedPrompt:1`, and an ON `inputEvidenceEnabled` marker. It must also require a
  message-bound admission receipt within a bounded timeout. Missing receipt
  means **not delivered**; durable message storage alone is not admission, and
  the caller must not wait forever. A runtime can be replaced after discovery,
  so fresh discovery does not remove the receipt/timeout requirement.
  An **OFF runtime never executes a guarded prompt** and publishes no admission
  envelopes. Its metadata may retain a prior ON runtime's advertisement. Handling
  this stale-advertisement/absent-receipt case belongs to the Desktop T2 sender;
  this PR deliberately makes no T2RT-33 runtime behavior change.
- **T2RT-22:** before an orphan snapshot discards a claimed continuation,
  cancel its exact original retry receipt, make it terminal/incomplete and
  publish an evidence-only revision with `missing-provider-turn`. A fresh empty
  orphan revision can follow, but cannot substitute for settling that root or
  claim the missing turn consumed input. Claim deletion and retry identity checks
  prevent duplicate settlement. A six-case tracker matrix covers pre-write and
  post-write/pre-start failures for `claude-transient`, `claude-account-switch`
  and `codex-capacity`; the existing actual-stdin-write T2RT-06 case and a new real
  Codex overload/write/pre-start-failure loop cover the transport boundary.
  Claude normally reports launch failure through main's native mapper; the
  shared tracker matrix covers missing-turn settlement without inventing a
  Claude native no-start path.

The focused four-file selection passes **229/229 tests**, including **30/30
parity scenarios** (**60 source replays**). All 26 earlier scenarios remain in
the orchestrator. The reviewer's unchanged launcher/Codex scripts pass **16/16**;
their four refusal sequences equal the extracted baseline and their failed
written retry's original root is now terminal/cancelled with the missing-turn
reason and exactly the original two native lifecycle frames.

Final related validation:

- Standard 46-file selection: **1313 passed / 1 failed out of 1314**. The sole
  failure was `runClaude.test.ts`'s one-second harness-start wait in the existing
  already-titled-chat control. The unchanged file then passed **62/62** alone
  with the standard command; no timeout or production change was made for it.
- This selection passed all launcher/personal-fallback controls (including all
  26 setup-token-switch tests), the 15 unchanged merge-base ordering cases,
  mapper/scanner/channel/evidence/API, Codex retry, daemon and managed-startup
  checks. The source orchestrator passed **30/30 scenarios / 60 source replays**.
- The reviewer's root-settlement test also passed against fresh replay output
  (only its external output-file path was redirected to preserve the original
  reviewer artifacts). Its assertions were unchanged.
- CLI typecheck and pkgroll/extension-copy build passed through standard global
  setup, including the isolated rerun. Existing bin/empty-chunk, listener and
  asynchronously-handled-rejection warnings remain. No Unix-socket EPERM occurred.
- The routing parser/insertion/rearm/final helpers and the API native runtime
  side-effect method remain byte-identical to `9ee84191`. `git diff --check`
  passed. No native wire turn is constructed by evidence, and no routing state,
  request map, schema, dependency, Desktop source or runtime pin was changed.

## T2RT-23..24: default-off opt-in, completion waiting and textless receipts

The reviewer's unchanged reproductions first yielded **7 failures / 2 passing
controls** on `c7b4f8c2`: six metadata-plus-idle/ready early completions and the
pending textless recovery receipt. Durable happy-agent regressions reproduced
all six failures, and real Claude/Codex entry-point tests rejected automatic
enablement for unset/`0`/`true` while keeping `1` as the explicit ON control.

**T2RT-23:** `happy-agent` ignores `turn-input-evidence` and
`hub-input-admission` before changing either `sawActivity` or
`sawNonReadyMessage` in completion waiting. The encrypted socket-update matrix
covers late mapped evidence from A, turn-less evidence and admission before B
starts, each followed by idle or legacy ready, plus both no-metadata controls.
The same waiter remains pending through B's start and completes on B's end.
All original 31 session tests and the eight new cases pass.

The producer-side protection is the explicit launch opt-in documented above.
Claude and both initial/replacement Codex queue configuration default OFF;
older installed readers no longer need a runtime pin to avoid these envelopes.
Enabled receipt tests set the flag explicitly, and the existing API capability
gate remains the single publication boundary for evidence/admission metadata.
Managed startup controls now assert the default-off configuration.

**T2RT-24:** when a claimed continuation resumes inside a still-open native
turn but returns only an empty result, its authoritative native terminal now
settles that exact receipt. The guard requires the current native turn, runtime,
claimed object membership and retry ID to match. With no mapped consumption
proof, the original root receives one evidence-only terminal cancellation with
incomplete coverage and `continuation-consumption-unproven`; the native completed
end carries the same settled evidence. It retains A's original identifiers and
does not invent a consumed retry input or a new turn. A stale native terminal or
different retry receipt cannot cancel a newer pending continuation. Existing
text/tool/final-producing recovery still completes normally on the same root.

The launcher-level source replay now includes the reviewer's empty-result script
with evidence OFF and explicitly ON. It preserves exactly main's one native
start and one completed end and asserts terminal/cancelled evidence plus exactly
one terminal metadata revision on the original root when enabled.

Parity runs all **30 existing scenarios plus two textless recovery variants** in
each opt-in mode. OFF compares **all session-protocol envelopes** with main,
including IDs, payloads, order and count. Only independently random SDK transcript
UUIDs are canonicalized bijectively; native wire envelope/turn IDs remain exact,
with the existing scripted ID generator and clock. ON compares native turn
sequences, routing and actual consumer outcomes and retains incomplete/no-cross-
turn-stamp assertions. Separate observations can be exported as documented above.

Final verification: **32/32 OFF and 32/32 ON scenarios**, **128 source replays**;
happy-agent session/encryption/CLI checks **106/106** with typecheck/build passed;
reviewer metadata/empty-result replay **9/9** against the actual updated sources
(only copied consumer import paths/output and dependency alias were redirected,
without changing assertions). The standard CLI selection excluding the separately
run `runClaude` file passed **45 files / 1258 tests**. A prior parallel focused
run hit one existing one-second `runClaude` harness-start wait; its timeout is
unchanged. The isolated file passed **66/66** using the standard command, for
**46 files / 1324 related CLI checks** across those runs. All personal-fallback,
unchanged merge-base compatibility, API/evidence, mapper/scanner/channel, Codex,
daemon and managed-startup checks passed.

CLI typecheck and pkgroll/extension-copy build passed through standard global
setup, including the isolated run. Happy-agent typecheck/pkgroll build also
passed. Its dependencies were prepared with a filtered frozen-lockfile install;
no dependency or lockfile changed. Existing bin/empty-chunk, listener and
asynchronously-handled-rejection warnings remain; no Unix-socket EPERM occurred.
The routing parser/insertion/rearm/final helpers and native API runtime side-effect
method remain byte-identical to `9ee84191`. `git diff --check` passed. No Desktop,
server, wire schema, channel routing or native lifecycle ownership changed.

## T2RT-25..27: full OFF compatibility and session-owned settings

The first durable focused run on `2881f960` produced **15 failures / 301 passes**:
non-channel/empty-plan publication, per-request option admission and inheritance,
resume retention/override, daemon spawn scrubbing, capability advertisement and
guard acceptance/receipt consistency. The reviewer's request/environment helpers
also failed both original scope cases. These tests pass after the changes.

- **T2RT-25:** the Codex mapper's default final-candidate predicate is main's
  channel predicate. Only an opted-in session adds non-channel candidates with
  a mapped turn. Channel candidates retain main behavior even with no current
  turn, independently of opt-in. A new null-turn channel control first caught
  an overly restrictive draft condition, then passed after preserving the exact
  main predicate. Empty SDK plans are ignored while OFF and published as a clear
  only while ON; nonempty plans keep main's behavior in both modes. The runner
  supplies its captured session setting to both converters.
- **T2RT-26:** `utils/inputEvidenceSettings.ts` owns validation/capture, shared
  by spawn handling and runners. Request `0`/`1` values are explicitly admitted
  after environment scrubbing; unsupported request values fail before spawn.
  Implicit inheritance is removed at daemon/new-session boundaries, including
  both actual `daemon start` and `start-sync` spawn paths. The existing captured
  session environment, persistence hydration and resume builder retain the
  owner's value, with explicit resume overrides. Runner startup consumes the
  seed before awaits, recovers only from its own metadata when needed, and uses
  the captured boolean after auth/env changes and session replacements. OFF
  fresh metadata remains unchanged; ON records a boolean recovery marker.
- **T2RT-27:** OFF publishes no T2rt contact advertisement and withdraws stale
  ones. Guarded inputs are refused in that mode, never run after removing their
  guards. ON advertises the guard contract only with admission publication.
  Acceptance tests cover matching/malformed/stale guards, queued mode-change
  invalidation, durable accepted/rejected server-ID receipts, and OFF's unchanged
  metadata/no receipts. Unguarded main input remains supported.

The paired source orchestrator now covers **58 scenarios per mode**, all against
actual `9ee84191` and HEAD sources. It retains all 32 prior scenarios and adds 26
ordinary Codex/channel output, empty/nonempty plans, ordinary Claude/channel
output, permission/question, steer, Codex/Claude retry, metadata-mode-transition
and guard/admission cases in both capability states. OFF compares every
session-protocol envelope **and the whole metadata document**, with exact native
wire IDs, turn IDs, payloads, order and count. The fixture fixes the clock in
both sources; independently generated transcript UUIDs retain the existing
bijective canonicalization. ON retains native-turn/consumer parity and asserts
the added candidates, empty plans, capabilities, admissions and evidence.

Verification:

- **58/58 OFF and 58/58 ON**, **232 source replays**. The external reviewer's
  five fresh OFF full-wire captures also equal their merge-base captures,
  including both Codex/channel and plan controls; neither OFF contact metadata
  nor admission envelopes are added. Both reviewer environment cases now pass.
- Standard related CLI selection: **52 files / 1481 tests passed**, including
  source parity, API/evidence, all launcher/personal-fallback controls except the
  separately run `runClaude` file, unchanged merge-base routing compatibility,
  Codex, daemon resume/env/persistence hydration, actual daemon spawn, child-env
  wiring and managed startup.
- The separate 71-case `runClaude` file ran twice: each run passed 69 cases and
  hit two different existing one-second harness-start waits. All four affected
  controls passed when run by name (**4/4**); all new capture/recovery cases
  passed in both runs. Its wait settings are unchanged. This records the flaky
  full-file result rather than claiming a clean whole-file pass.
- CLI typecheck and pkgroll/extension-copy build passed in standard global setup
  after correcting a test-mock tuple typing error. Existing bin/empty-chunk,
  listener and asynchronously-handled-rejection warnings remain. No Unix-socket
  EPERM occurred. `git diff --check` passed; the Claude routing helpers and native
  API runtime side-effect method remain byte-identical to `9ee84191`. No dependency,
  lockfile, Desktop/server source, wire schema or other branch changed.

Resume settings use existing per-session captured state and encrypted metadata;
no daemon-wide preference, credential policy change or additional authority is
introduced. The Desktop consumer prerequisites above remain mandatory before
opting in. Native wire turn ownership and channel routing remain main's.

## T2RT-28: replacement-ID recovery (2026-10-26)

Review base: `1b26f35f`. The user authorizes a new behavioral commit and normal
push on `feat/rn-t2rt-input-evidence`; no rebase, force-push or PR creation.
The earlier exclusion of `daemon/run.ts` is superseded for this narrow fix.

Plan (Core, existing session state; no new API, dependency or authority):

1. Reproduce replacement-ID loss at the actual `spawnRecoveredSession` boundary
   for Claude/Codex, absent/corrupt cursors and both saved sources, with explicit
   OFF/ON overrides and an unrelated-session control.
2. Resolve only the original owner's validated evidence setting: saved validated
   environment, then original metadata, then validated explicit request override.
   Forward that single setting without copying the original environment.
3. User follow-up includes standalone `happy resume <id>`: share resolution with
   daemon recovery, restore only the resolved setting from the original full ID,
   and support explicit `--input-evidence 0|1` without reading the caller's flag.
4. Audit other resume/recovery/restart and reattachment paths, run focused
   regressions/typecheck/build, record results and commit/push normally.

Rollback: revert the new behavioral commit. Routing and native wire lifecycle
remain unchanged; unrelated sessions still default OFF.

Implementation: `resolveRecoveredInputEvidenceEnvironment` in the existing
settings module is shared by daemon replacement recovery and standalone Happy-ID
resume. It admits saved literal `0`/`1` only, falls back to the original session's
boolean metadata marker, and validates/overlays explicit request `0`/`1` last.
Only that setting is carried; neither path copies the original environment.
Standalone CLI overrides use an argument so an opted-in caller cannot implicitly
enable a different conversation. The resolved full ID, not a user-supplied
prefix, selects persisted state. Neither routing nor provider/native lifecycle
code changes.

Recovery/resume/restart audit (all source paths relative to
`packages/happy-cli/src`; grouped callers share the implementation named here):

| Path | Evidence setting resolution |
| --- | --- |
| `daemon/run.ts:spawnRecoveredSession`, replacement Happy ID | New shared resolver: original validated saved setting → original server metadata → validated explicit request override. Applies to Claude and Codex, absent or corrupt processed cursor. |
| `resume/handleResumeCommand.ts:handleResumeCommand` (`happy resume <id>`) | Same shared resolver using the original full Happy ID; `--input-evidence 0\|1` overrides. Caller evidence env is scrubbed; only the resolved setting is added back. No cursor is needed for this native-conversation/new-Happy-ID launch. |
| `daemon/run.ts:spawnRecoveredSession`, same Happy ID | `hydrateRecoveredSessionFromPersisted` validates the owner's captured environment, then `spawnResumedSession` below supplies the owner's current reconnect metadata and request override. |
| `daemon/run.ts:spawnResumedSession` (machine RPC, control/terminal resume, idle-reaped/stopped sessions, restored worktrees, unused Codex/unstarted execution-bound Claude) | `buildResumedSessionSpawnEnvironment` retains the owner's captured setting, overlays validated request/automation settings, and scrubs inherited flags. Claude/Codex runners consume once and fall back to that owner's `buildReconnectSessionEnvironment` metadata only if no saved/request setting survives. |
| Daemon restart/live-child reattachment, persisted finished-session lookup and orphan adoption (`daemon/run.ts`, `daemon/persistedSessionHydration.ts`, `daemon/orphanAdoption.ts`) | Existing live runners keep their captured boolean. Tracked/finished records hydrate the validated per-session environment; later child replacement uses the same `spawnResumedSession` route and own server metadata. No daemon-wide flag is restored. |
| Checkpoint protection refresh/disable restart (`daemon/checkpointProtectedRestart.ts`), write-scope replacement (`daemon/sessionWriteScopeRestart.ts`, `daemon/sessionWriteScopeRuntime.ts`) | Preserve the original tracked state, then call `spawnResumedSession`; their policy-only overlays do not change the evidence setting. |
| Scheduled automation target resume, autonomous-quality ensure-running, durable session follow-up and BYOS offline-delivery wake (`daemon/run.ts:resumeAutomationSession` and `ensureSessionRunning`/`ensureRunning` adapters) | All reach `resumeSession` → `spawnResumedSession`. Automation's validated explicit setting can override its target's saved value; no override means own saved value/own metadata. A fallback/new automation spawn is a new session and defaults OFF. |
| Held browser-attention/continuation wakes (`daemon/run.ts:resumeForBrowserAttention` and browser continuation broker) | Same resume route; re-sends that session's remembered request environment, never another session's flag. Restart hydration retains its own setting. |
| Claude transient retry, account/setup-token switch, local/remote switch, checkpoint/provider restart, MCP reconnect, native-session change/compact (`claude/runClaude.ts`, `claude/loop.ts`, `claude/claudeRemoteLauncher.ts`, `claude/session.ts`) | Keep the same Happy client/runner and its already-captured boolean. Credential/env updates and native-session ID changes do not re-read the flag. |
| Codex capacity continuation, app-server reconnect/thread resume, forced-interrupt restart, idle auth recovery, MCP/checkpoint recovery, native thread reset (`codex/runCodex.ts`, `codex/codexAppServerClient.ts`, `codex/codexMcpRuntimeRecovery.ts`) | Keep the same Happy client/runner and captured boolean. Provider reconnect/resume cannot enable/disable it. |
| Offline→online client replacement (`utils/setupOfflineReconnection.ts`, `claude/runClaude.ts`, `codex/runCodex.ts`) | Carry the captured metadata; Codex's `onSessionSwap` explicitly configures the new client with the same captured boolean. Claude's offline local transcript bridge carries that metadata without starting a new remote input queue. No process-env re-resolution. |
| Precreated channel-host and machine-bound initial attachments (`channelHost/channelHostSessions.ts`, `daemon/machineSetupTokenRuntime.ts`), managed run bootstrap (`managed/managedStartup.ts`) | These attach the session just allocated for a new launch/run, not an original conversation being recovered. Validated explicit session seed applies, otherwise OFF; no prior/caller setting is borrowed. Later machine-bound resumes go through `spawnResumedSession`. |
| Direct native-ID `happy --resume` / `happy codex --resume`, forks/duplicates and unrelated spawns | These are new Happy launches without an original Happy-ID recovery contract. They retain default OFF unless explicitly seeded under the existing direct/daemon launch contract; parent lineage/native IDs never imply opt-in. |

TDD verification. Initial daemon red: **24 failures / 56 passes**
(18 setting-preservation assertions and six invalid-request-before-spawn checks).
Initial standalone CLI red: **36 failures / 23 passes** (missing restoration and
unsupported explicit override). Test fixture typing was corrected before these
red runs; no production code changed until each boundary's red run completed.

Final local verification: **14 files / 369 tests passed across the focused runs**:

- Actual daemon recovery boundary: **80/80** (Claude/Codex × absent/corrupt cursor
  × saved/metadata precedence × absent/explicit OFF/ON override, plus missing
  record and invalid-request controls). Every matrix case also verifies unrelated
  launches default OFF and prior environment/lineage is not copied.
- Standalone resume/parser/help: **62/62**, including both providers, metadata-only,
  saved ON/OFF precedence, corrupt saved option fallback, full-ID lookup from a
  prefix, caller-env isolation, explicit OFF/ON, invalid/missing/duplicate options
  and unrelated-session controls.
- Codex capacity/startup/capture/resume: **31/31**.
- Claude startup/capture/own-metadata resume: **9/9** selected by
  `-t 'T2RT-(23|26)'`; **62 unrelated cases intentionally skipped**. No whole-file
  or whole-suite Claude pass is claimed.
- Supporting session env, reconnect snapshot, persistence hydration, recovery
  decision, request-env memory/wiring, checkpoint restart, write-scope restart and
  original-session lookup: **185/185** across nine existing files.
- Source parity: **58/58 OFF and 58/58 ON**, **232 source replays** in two passing
  parent tests. OFF still matches `9ee84191` in full envelopes and metadata;
  ON preserves native-turn/routing/consumer parity. No routing code changed.

All commands ran from the clone root using
`corepack pnpm -C packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
The ten-file daemon/supporting selection passed during the first green attempt;
that same invocation also exposed 36 CLI fixture assertions against a pre-existing
inherited sandbox policy. Isolating that fixture (no production-policy change)
and adding parser boundary cases yielded the clean 62-case CLI rerun above.
The CLI/Codex/parity invocation passed **95/95**; the selected Claude invocation
passed **9/9**. These are distinct cases, not repeated runs added to the total.

Standard global setup passed CLI `tsc --noEmit`, pkgroll and extension-copy build.
Existing bin-outside-dist/empty-chunk warnings remain. No Unix-socket EPERM or
other environmental failure occurred. `git diff --check` passed. Happy has no
Desktop release-note, guide or preflight script; no Desktop, server, wire schema,
package version, dependency or lockfile changed. No paid-provider/live-app test
or whole-suite run is claimed.

Status: implementation, audit and local verification complete. The authorized
branch receives one new behavioral commit on `1b26f35f` and a normal push; no
history rewrite, other-branch mutation, PR creation or publication.

## T2RT-29: metadata writer preservation and live repair (2026-10-26)

**Historical implementation and verification.** The live repair described in
this section was removed by the T2RT-30/31 decision below. App passthrough, title
write-back/CAS/ACK preservation, the writer audit, and recovery precedence remain.
Historical test counts here describe that earlier implementation only.

Review base: `5c5d4f2b`. The approved scope includes happy-app write-back and
shared CLI session-host repair, plus a read-only writer audit. One new behavioral
commit and normal push on the same branch; no PR or history rewrite.

Plan (Core: session metadata consistency, existing transport and ownership):

1. Reproduce title write-back and CAS conflict loss using actual app metadata
   parsing/encryption/title/write-back source and the real recovery resolver.
2. Preserve unknown metadata, including nested runtime capabilities and summary
   fields; CAS retries must retain the newest server-owned unowned fields.
3. Live Claude/Codex session hosts restore missing captured-setting markers after
   metadata observation, with idempotent writes and no overwrite of explicit
   values, foreign runtime contact, or archival. Test socket/CAS paths and delayed acknowledgements.
4. Audit Happy server/agent/CLI/app, Desktop and pinned runtime writers; document
   the offline old-app residual; rerun focused tests and OFF/ON source parity.

Rollback: revert this new behavioral commit. No routing, wire schema, session
setting resolution order, dependency, provider or public authority changes.

Implementation and ownership:

- Happy-app's `MetadataSchema` passes through unknown root keys and unknown keys
  inside runtime capabilities, summary and the declared model/mode/MCP records.
  Known-field validation remains in place. The actual `SessionEncryption` parser
  and cache retain those values instead of projecting them away.
- The title transform preserves unowned summary fields. CAS retry merges only
  `summary.text`/`updatedAt` onto the newest server record, including its branch
  slug and future fields. The ACK is decrypted and cached together with its
  version in storage; a subsequent title edit without a socket refresh retains
  newly discovered fields. A pending local title survives ACK application and
  an older ACK cannot replace a newer observed session document.
- The shared `ApiSessionClient` receives Claude/Codex's already-captured setting
  via `configureInputQueue`. ON records its current contact advertisement and
  repairs only omitted setting/contact keys when newer socket metadata arrives.
  Outgoing transforms/CAS retries recheck current metadata and current mode.
  Present values (including explicit OFF), foreign runtime contact and archival
  are left alone. OFF never adds markers; disabling withdraws stale markers.
- Claude's offline→online local transcript bridge does not configure a remote
  queue. It explicitly passes the runner's captured boolean to
  `configureInputEvidenceRecovery`, owning only the recovery hint. It can repair
  that omitted hint without enabling evidence publication, guarded admissions,
  or an `agentContact` advertisement. A callback after process-env mutation
  retains the captured ON/OFF choice; it never reads a later ambient seed.
- Repair transforms return the unchanged record once satisfied; only this new
  repair path skips unchanged writes. Confirmed echoes and multiple queued
  observations do not create extra writes. Delayed repair ACKs cannot roll back
  a newer observed document or suppress its pending repair. That ACK freshness
  guard is ON-only so OFF retains the baseline's existing ACK behavior.
- Recovery resolution is unchanged: the daemon-saved validated setting is first,
  followed by original metadata and then validated explicit request override.

**Residual for installed old app versions:** while no online CLI host observes
the session, no live repair can restore a stripped hint. An old app title edit can
remove `inputEvidenceEnabled` and `agentContact` from server metadata. If no
validated saved session environment remains, later metadata-only recovery is
OFF. This can disable evidence, never incorrectly enable it. Saved validated ON
still restores ON; saved/explicit OFF wins; contact capability alone is never
used as an ON recovery hint. No attempt is made to repair installed old apps or
bypass the Desktop consumer prerequisites.

Writer audit (source inspection, not a live fleet claim):

| Writer / reader | Finding |
| --- | --- |
| `happy-app/sources/sync/storageTypes.ts`, `encryption/sessionEncryption.ts`, `storage.ts`, `ops.ts` | The actual stripping writer, fixed as above. Both first write and CAS retry retain unowned root/nested fields. ACK/cache consistency prevents a second write from reintroducing the loss. The only `sessionUpdateMetadata` caller is the title write-back in storage. Machine metadata has a separate schema/endpoint and is not session metadata. |
| Current happy-cli `api/apiSession.ts`, Claude/Codex title/provider/lifecycle handlers, `utils/reconnectSessionMetadata.ts` | Metadata is decrypted as the complete record; ordinary handlers spread the current document. No session metadata projection schema in the API writer. Fresh launcher-owned runtime capabilities are republished by the opted-in host. New repair covers old writers dropping the two host markers while this process is live. |
| happy-cli `resume/resolveHappySession.ts` and daemon persistence hydration | `ResumableMetadataSchema` already uses passthrough; saved environment hydration admits only validated session values. Neither writer-side schema changes nor the repair change the T2RT-28 precedence. |
| `happy-server/sources/app/api/socket/sessionUpdateHandler.ts`, session create routes and managed bridges/execution binding | Server treats metadata as opaque encrypted strings, applies version CAS, stores and relays the supplied ciphertext unchanged. It cannot project decrypted keys. Session creation with an existing tag returns the existing record instead of overwriting it. No server change required. |
| `happy-agent/src/session.ts`, `api.ts`, `index.ts` | Raw metadata decrypt/read and new-session creation only; no existing-session `update-metadata` emitter or metadata parse/projection/write-back path found. Existing-tag create goes through the server behavior above. No agent change required. |
| Desktop at `d58812b75e41f384d0c5242b011249fea074efea`: `src/sync/sessionMetadataMutation.ts`, `sessionMetadataCipher.ts`, `sessionTitle.ts`, `projectConversationLifecycle.ts` | Title rename and lifecycle restore open the raw complete `Record<string, unknown>`, spread it, change owned fields and repeat against the latest conflict record. Neither legacy nor DEK cipher projects fields. No equivalent strip found. Desktop was inspected read-only. |
| Desktop `src/sync/standaloneImport.ts` | New imported record spreads decrypted metadata, deliberately removes the local machine ID and adds import provenance; no projection of these markers. It is not an existing-session title writer. No Desktop CLI/Electron direct existing-session metadata writer found outside the shared mutation path. |
| Desktop-pinned CLI `9ee84191cf6e6b2739987be3f5488ef511c6474f` (`1.1.10-aplus.357`) | Its API metadata writer uses raw records and spread-based title/lifecycle transforms, preserving unknown root keys. Its shallow reconnect merge overlays fresh launcher metadata, including a new `runtimeCapabilities` object, so startup can discard an earlier nested contact advertisement. This old runtime has no T2rt support or self-heal and is not an evidence-capable host. The existing no-Desktop-opt-in prerequisite remains mandatory; a pin upgrade alone is not enablement. No pinned source/branch was changed. |

TDD and verification:

- First standard red run: **23 failed / 4 passed / 171 unrelated cases skipped**.
  It reproduced app forward-field loss and live omission/CAS repair absence,
  with OFF/explicit-OFF/foreign-runtime/archive controls passing.
- First implementation: **199/199** across API and actual-app round-trip tests.
  Further inspection found the app ACK cache/version gap. Extending the actual
  storage ACK callback/second-title-write test produced a second red run:
  **16/16 failed**, covering both CAS cache loss and stale ACK overwrite.
- The final path audit found the offline→online Claude local bridge needed its
  own marker-only ownership seed. Actual runner reproduction: **2 failed / 2
  existing controls passed** before that seed was added. Both captured OFF/ON
  cases now pass after changing the process seed during the async boundary.
- Final API/producer→consumer selection: **203/203** (186 API checks, including
  15 live repair/ownership/race/local-bridge controls; 17 actual-app/recovery checks).
  The app harness executes actual production schema, encryption/cache classes,
  title transform, metadata writer and ACK callback. Crypto uses real CLI legacy
  encryption through the app adapter; transport alone is simulated. No copied
  schema, writer or storage-transform implementation stands in for production.
- Related recovery/resume/env/hydration selection: **269/269** across four files
  (80 replacement recovery, 62 standalone resume, 108 environment, 19 hydration).
- Source parity: **58/58 OFF and 58/58 ON**, **232 actual source replays** in two
  passing parent tests. OFF still matches `9ee84191` for complete envelopes and
  whole metadata documents; ON retains native lifecycle/routing/consumer parity.
  No mapper, routing parser, native lifecycle or wire schema changed.
- Claude offline branch: **4/4**, including both new captured-setting/bridge
  ownership checks and the two existing required-confirmation controls.
- Final standard invocation: **8 files / 478 tests passed**, with no skipped
  cases in that invocation. Earlier iteration passes are not added to this total.

All tests used the requested command from the clone root:
`corepack pnpm -C packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
Files: `src/api/appMetadata.inputEvidence.test.ts`, `src/api/apiSession.test.ts`,
`src/api/apiSession.inputEvidenceLifecycle.test.ts`,
`src/daemon/sessionRecovery.inputEvidence.test.ts`,
`src/resume/handleResumeCommand.test.ts`, `src/daemon/sessionEnv.test.ts`,
`src/daemon/persistedSessionHydration.test.ts`,
`src/claude/runClaudeOfflineAck.test.ts`.
CLI global setup passed `tsc --noEmit`, pkgroll and extension-copy build. Existing
bin-outside-dist/empty-chunk warnings remain. No Unix-socket EPERM occurred.
`git diff --check` passed.

Full Expo app typecheck/build was not run: config resolution with
`tsc --showConfig --project ../happy-app/tsconfig.json` reports TS6053,
`expo/tsconfig.base.json` not found; happy-app dependencies are not installed in
this clone. Actual app runtime source was exercised via the CLI harness above;
that does not substitute for an Expo/native build. No whole-suite, live-provider,
Desktop application, server integration or fleet validation is claimed. No
package/dependency/lockfile/version, Desktop source or runtime pin changed.

Status: implementation, writer audit, residual documentation and focused local
verification complete. One new behavioral commit on `5c5d4f2b`, normal push only;
no PR creation, force-push, rebase, publication or other-branch mutation.

## T2RT-30/31: remove live marker repair (2026-10-26)

**Historical verification at `3303bc51`.** T2RT-32 below removes the remaining
OFF contact-withdrawal branch and expands the incoming-document parity matrix.
The parent subsequently pushed this commit; the no-push instructions recorded
in this section applied to that author turn only.

Current base: `9ddebeac` on `feat/rn-t2rt-followup` (PR #965), after #951 merged.
The user's decision supersedes T2RT-29 part (b): remove live marker repair
entirely, retaining app passthrough (a) and recovery precedence (c). This is an
existing Core metadata consistency correction with no new dependency or protocol.
The latest instruction authorizes one local commit and **no push**; the parent
session will push after the review bot finishes.

Plan and implementation:

- Remove the repair state, observation hook, outgoing-transform/CAS repair,
  repair-only no-op/ACK handling, and Claude offline-bridge repair configuration.
  Session-owned capture and normal ON advertisement remain unchanged. Startup's
  explicit OFF transform still removes the marker. Existing contact withdrawal
  remains; a marker-only document cannot trigger an extra OFF mode-change write.
- Replace repair expectations with real encrypted socket/CAS regressions for
  Claude and Codex: passive setting/contact/both omissions, ordinary title writes,
  overlapping ON hosts followed by production OFF startup, and marker-only
  incoming metadata followed by local/transitioning/remote mode changes.
- Keep the app producer-consumer, saved-environment/metadata/explicit override,
  standalone resume, daemon recovery, hydration and environment tests. Extend
  source parity with four OFF marker-only/mode-transition cases while retaining
  all original 58 OFF and 58 ON scenarios.

Recovery still prefers the original session's saved validated `0`/`1`, falls
back to original metadata, then overlays any validated explicit request. No
caller process environment or unrelated previous-session environment is inherited.
**Residual:** an installed old app can strip the marker even while a session is
live; no host restores it automatically. If only stripped metadata survives,
later metadata-only recovery is OFF. This never turns evidence ON wrongly.
Current app passthrough preserves the hint; saved validated environment or an
explicit request remains authoritative. Revisit only with a separately approved
ownership-fenced repair design and proof of strict OFF publication parity.

TDD and final verification:

- Red: all **10/10** new API cases failed (171 unrelated tests skipped),
  reproducing both reviewer scenarios for Claude/Codex and the passive-omission
  cases. Green: all 10 pass after removing repair. The handoff tests start with
  an ON marker, observe the replacement ON owner, then use the actual reconnect
  merge and OFF transform. Only the OFF runner's single startup refresh is sent;
  the stale host never reclaims either marker, and OFF still refuses guarded input.
- **8 files / 473 tests passed** in the final standard invocation: 181 API,
  17 actual-app producer-consumer/recovery, 80 replacement recovery, 62 standalone
  resume, 108 environment, 19 hydration, 4 Claude offline/reconnect and 2 source
  parity parent tests. No skipped cases in this run.
- Parity against `9ee84191`: original **58/58 OFF + 58/58 ON**, plus **4/4 OFF**
  marker-only incoming documents across Claude/Codex and local/remote initial
  modes. Each added case traverses local/transitioning/remote/local/remote,
  preserves every whole metadata snapshot and emits **zero metadata writes**.
  Total: **62 OFF + 58 ON**, **240 actual source replays**. Full OFF envelopes,
  native turns, routing and consumer observations retain baseline parity.
- CLI global setup passed `tsc --noEmit`, pkgroll and extension-copy build.
  Existing bin-outside-dist/empty-chunk warnings remain; no Unix-socket EPERM
  occurred. `git diff --check` and the T2rt documentation anchor check passed.

Command from the clone root:
`corepack pnpm -C packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
Files: `src/api/appMetadata.inputEvidence.test.ts`, `src/api/apiSession.test.ts`,
`src/api/apiSession.inputEvidenceLifecycle.test.ts`,
`src/daemon/sessionRecovery.inputEvidence.test.ts`,
`src/resume/handleResumeCommand.test.ts`, `src/daemon/sessionEnv.test.ts`,
`src/daemon/persistedSessionHydration.test.ts`,
`src/claude/runClaudeOfflineAck.test.ts`.
Production `apiSession.ts` and `runClaude.ts` match their pre-repair parent
`1e7549f6` exactly; app passthrough and recovery resolution sources are unchanged.
No new PR or push is performed in this session.

## T2RT-32: OFF mode transitions never publish metadata (2026-10-26)

Base: `3303bc51`, branch `feat/rn-t2rt-followup`, PR #965. The review bot has
reviewed the prior base; the current user authorizes one new commit and normal
push, with no new PR or history rewrite. Existing Core metadata consistency fix;
no dependency, protocol, app schema, recovery precedence or routing change.

Plan:

1. Reproduce incoming stale/foreign contacts and overlapping OFF/ON hosts using
   real API clients, encrypted socket observations and simulated server CAS.
   Include both providers, marker absent/present, and an incoming contact naming
   this runtime as a control. An OFF queue configuration must not publish even
   if that client previously advertised ON in a direct API test.
2. Remove ordinary OFF contact withdrawal and its otherwise-unused advertisement
   state. Production captures the setting once; there is no live opt-out flow
   needing a new owned-withdrawal operation. ON advertisements remain unchanged.
   The existing launch-time metadata construction and explicit OFF marker
   transform remain unchanged; no new contact deletion operation is introduced.
3. Extend actual-source full-document OFF parity: Claude/Codex, local/remote
   initial mode, absent/stale/foreign contact, absent/present ON marker, each
   followed by local/transitioning/remote/local/remote. This is 24 document cases
   (the prior four marker-only cases plus 20 additions), retaining 58 original
   OFF and 58 ON scenarios. Run related app/recovery/resume/env/hydration tests.

Rollback: revert this new commit. Saved validated environment still wins over
metadata fallback, then validated explicit request overlay; old stripping writers
with metadata-only recovery still safely default OFF. App passthrough remains.

TDD red: **15/15 direct T2RT-32 cases failed** before the production change,
including both overlapping-host cases. The expanded OFF parity parent also
failed with contact deletions; ON parity passed. Standard run: **16 failed,
1 passed, 180 unrelated cases skipped**.

Final verification:

- **8 files / 487 tests passed**, no skipped cases: 195 API (including all 15
  T2RT-32 checks), 17 actual-app producer-consumer/recovery, 80 replacement
  recovery, 62 standalone resume, 108 environment, 19 hydration, 4 Claude
  offline/reconnect, and 2 actual-source parity parent tests.
- **82/82 OFF + 58/58 ON** against `9ee84191`, **280 source replays**. This
  retains the original 58 OFF + 58 ON and covers all 24 incoming-document cases
  (8 contact-absent controls, 16 stale/foreign-contact cases). Every OFF transition
  preserves the complete metadata document and sends zero metadata writes.
  Both overlapping OFF/ON hosts preserve the current ON runtime's contact and
  guarded-prompt/evidence capabilities without increasing the server write count.
- The direct cases also preserve an incoming contact naming the OFF runtime
  itself, test steering-availability mode updates, and verify that OFF queue
  configuration cannot implicitly withdraw even this client's prior advertisement.
- CLI global setup passed `tsc --noEmit`, pkgroll and extension-copy build.
  Existing bin-outside-dist/empty-chunk warnings remain; no Unix-socket EPERM
  occurred. `git diff --check` and T2rt documentation anchors passed.

Tests ran from the clone root using:
`corepack pnpm -C packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
Files: `src/api/apiSession.test.ts`, `src/api/appMetadata.inputEvidence.test.ts`,
`src/api/apiSession.inputEvidenceLifecycle.test.ts`,
`src/daemon/sessionRecovery.inputEvidence.test.ts`,
`src/resume/handleResumeCommand.test.ts`, `src/daemon/sessionEnv.test.ts`,
`src/daemon/persistedSessionHydration.test.ts`,
`src/claude/runClaudeOfflineAck.test.ts`.
App passthrough, recovery resolution, runner startup, routing and wire schemas
are unchanged. One new behavioral commit on the requested branch, normal push
only; no new PR, rebase, force-push or other-branch mutation.

## T2RT-33/34: caller admission prerequisite and startup CAS setting (2026-10-26)

Base: `a0ecd641`, branch `feat/rn-t2rt-followup`, existing PR #965. User-approved
scope: T2RT-34 runtime fix; T2RT-33 documentation only, with no change to guarded
intake, admission envelopes, live marker repair or ordinary OFF metadata writes.
One new behavioral commit and normal push; no PR creation or history rewrite.
Existing Core metadata consistency fix, with no new dependency or protocol.

Plan:

1. Execute each provider's actual startup initializer and retryable callback with
   the real API CAS writer. Cover captured OFF/ON, zero/one/two concurrent title
   conflicts, ordinary/tracked state writes, newest unrelated metadata and later
   metadata-only recovery. A single existing startup write must suffice.
2. Apply the captured boolean inside both retryable startup transforms:
   `inputEvidenceMetadata(mergeReconnectSessionMetadata(meta, freshMetadata), inputEvidenceEnabled)`.
   Every CAS attempt reapplies the same setting to the newest document. No new
   metadata write, contact-deletion operation or caller environment read.
3. Record T2RT-33 next to the T2RT-21 prerequisites as a hard Desktop T2 sender
   contract: verify the live evidence-ON target with fresh matching contact and
   ON marker, and require a bounded, message-bound admission receipt; absence
   means not delivered. OFF never executes guarded prompts. No current caller
   opts in; the future Desktop T2 sender owns this prerequisite.
4. Rerun all existing 82 OFF + 58 ON source-parity scenarios and the new 24
   actual-runner CAS cases, plus related API/app/recovery/resume/env tests.

Rollback: revert this new behavioral commit. App passthrough and saved-setting
recovery precedence remain; old stripping writers with only metadata fallback
still safely default OFF. This fix prevents the distinct race that retained a
stale ON marker after explicit OFF startup.

TDD red: **16 conflict cases failed / 8 no-conflict controls passed**, with
195 unrelated API cases skipped. Both providers and both ordinary/tracked CAS
paths reproduced the captured-setting loss after one or two title conflicts.
The production change wraps each existing callback; all 24 cases now pass.

Final verification:

- **8 files / 511 tests passed**, no skipped cases: 219 API (including 24 new
  startup CAS cases), 17 actual-app producer-consumer/recovery, 80 replacement
  recovery, 62 standalone resume, 108 environment, 19 hydration, 4 Claude
  offline/reconnect, and 2 actual-source parity parent tests.
- Source parity: **82/82 OFF + 58/58 ON** against `9ee84191`, **280 source
  replays**, including the existing stale/foreign-contact and marker matrix.
  Routing, full OFF metadata and wire envelopes retain parity.
- The additional **24/24 actual-runner startup cases** execute production
  initializer/callback expressions with real encryption, the real API CAS writer
  and the real metadata-only recovery resolver; only the server transport/title
  race is simulated. Both settings survive every attempted CAS document, the
  latest concurrent title/unknown provider fields and original native identity
  survive, and each startup produces exactly one successful metadata write
  (one to three requests according to the number of conflicts). These are
  setting/recovery regressions alongside the paired source-parity matrix.
- CLI global setup passed `tsc --noEmit`, pkgroll and extension-copy build.
  Existing bin-outside-dist/empty-chunk warnings remain; no Unix-socket EPERM
  occurred. `git diff --check` and T2rt documentation anchors passed.

Command from the clone root:
`corepack pnpm -C packages/happy-cli exec vitest run --project unit <files> --maxWorkers 2`.
Files: `src/api/apiSession.test.ts`, `src/api/appMetadata.inputEvidence.test.ts`,
`src/api/apiSession.inputEvidenceLifecycle.test.ts`,
`src/daemon/sessionRecovery.inputEvidence.test.ts`,
`src/resume/handleResumeCommand.test.ts`, `src/daemon/sessionEnv.test.ts`,
`src/daemon/persistedSessionHydration.test.ts`,
`src/claude/runClaudeOfflineAck.test.ts`.
The production diff is two existing startup callback expressions. No API-session
runtime, guarded intake/admission, routing, app passthrough, environment capture
or recovery resolver behavior is changed. T2RT-33 remains a hard future Desktop
T2 caller prerequisite; it is not claimed as a runtime fix in this PR.
