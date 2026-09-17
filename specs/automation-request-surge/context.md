# Context

Date: 2026-09-17
Status: planned; implementation authorized by user.
Worktree: /Users/justin/workspace/aplus-dev-studio/.aplus/worktrees/mrfp6kjoyyfc/proud-finch-hb41/vendor/happy
Branch: fix/automation-request-surge
Do not edit main worktrees or other assigned worktrees. Preserve existing work.

## R5 — Existing server HTTP metrics (for the monitoring agent)

Source of truth: `packages/happy-server/sources/app/monitoring/metrics2.ts`
(definitions) and `packages/happy-server/sources/app/api/utils/enableMonitoring.ts`
(the Fastify `onResponse` hook that records them). No new metric is added by this
change; monitoring can consume these as they exist today.

| Metric | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `method`, `route`, `status`, `client`, `client_type` |
| `http_request_duration_seconds` | Histogram | `method`, `route`, `status`, `client`, `client_type` |

- Histogram buckets (seconds): `0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5, 10`.
- A global default label `app="happy-server"` is applied to every metric at scrape
  time (`register.setDefaultLabels`).
- `route` is **already normalized**: it is `request.routeOptions.url`, i.e. the
  Fastify route template such as `/v1/projects/:projectId/automations`. It falls
  back to the raw path (query string stripped) only when no route matched — that
  fallback is the one unbounded-cardinality source, and it is dominated by 404s.
- `method` is the HTTP verb; `status` is the numeric status code as a string.
- `client` / `client_type` come from `getMetricsLabelsFromRequest`, which parses the
  `x-happy-client` request header via `parseClientLabels`: `client` is the **raw
  header value** and `client_type` is the segment before the first `/`, lowercased
  (e.g. header `desktop/1.2.3` -> `client="desktop/1.2.3"`, `client_type="desktop"`).
  Missing header -> both `unknown`.
- **Cardinality caution for rules:** `client` carries the full version string, so it
  is the highest-cardinality label here. Prefer aggregating on `client_type`
  (expected values per the code comment: `cli-coding-session`, `cli-daemon`,
  `cli-control-plane`, `ios`, `android`, `web`, `desktop`) and only drill into
  `client` ad hoc.
- Automation GET route templates to match on the `route` label (never concrete ids).
  From `sources/app/api/routes/automationRoutes.ts`:
  `/v1/projects/:projectId/automation-target`,
  `/v1/projects/:projectId/automations`,
  `/v1/projects/:projectId/automation-runs`.
  From `sources/app/api/routes/scriptAutomationRoutes.ts`:
  `/v1/projects/:projectId/script-automations`,
  `/v1/projects/:projectId/script-automations/:automationId/runs`,
  `/v1/machines/:machineId/script-automations`.
  The evidence's "four automation GET routes" is not itself attributed to specific
  templates in the spec; treat this list as the candidate set, not a confirmed four.

Related socket-side metrics that already exist, in case the surge needs a
non-HTTP view: `websocket_events_total{event_type,client,client_type}` and
`rpc_calls_total` / `rpc_call_duration_seconds` (labels `method`, `result`) from
`sources/app/api/socket/rpcHandler.ts`.

---

## Implementation (2026-09-17) — server, `fix/automation-request-surge`

Status: implemented, verified locally, **not committed** (see Verification). Awaiting
primary-agent review.

### What changed and why

The surge multiplier was in `automationSocketHandler.ts`: four machine-socket events
(`automation-sync-ack`, `automation-claim`, `automation-run-start`,
`automation-run-report`) each announced a **project-scoped** change as
`emitAutomationUpdate(accountId, { projectId: null, ... })`. Desktop reads
`projectId: null` as "invalidate every project", so one daemon event fanned out into
a refetch of every project the account can see. `automation-sync-ack` was the worst
case: it emitted on *every* acknowledgement, including one that advanced no row at all.

**R1 — authoritative affected-project events.** The project ids now come from the
authorized service result inside the transaction, never from the socket payload:

- `claimAutomationRun` returns `projectId` from the `automation` row it already
  loaded and authorized (`machineAccountId`/`machineId` scoped).
- `startAutomationRun` and `reportAutomationRun` return `projectId` from
  `run.automation`, which `claimedRun()` already `include`s under the same scoping.
- `ackAutomationSync` returns `affectedProjectIds`, read back from the automation rows
  that its own scoped `updateMany` actually changed.

The handler emits `emitProjectAutomationUpdate(projectId, { projectId, ... }, accountId)`
per affected project. The socket payload's `projectId` (if a client ever sends one) is
ignored — a regression test passes `projectId: 'attacker-supplied-project'` and asserts
it never reaches an event.

**R2 — no-op ACK filtering.** `ackAutomationSync` counts only rows whose
`appliedRevision` advanced (`changed.count > 0`). Zero advanced ⇒ `affectedProjectIds: []`
⇒ the handler emits nothing and skips the project lookup entirely. A replayed
`automation-run-report` (`idempotent: true`) likewise emits nothing: it is the same
terminal state clients already hold. Failed operations still emit nothing, because
`answer()` only runs `onSuccess` when `result.ok` — now covered by a test.

Recipients are unchanged in kind: `emitProjectAutomationUpdate` fans out to the project
owner plus `status: 'accepted'` members, with the machine account as fallback, exactly
as `session-followup-evaluate`/`-deliver` already did. The wire event body is unchanged
except that `projectId` is now a real id instead of `null`, so old clients keep working
(a non-null `projectId` is already the normal case for the HTTP automation routes).

**R3 — scope retained where it must be.** `automation-key-register` still emits
`{ projectId: null, reason: 'machine-key' }` account-wide: a machine key rotation
genuinely invalidates every project bound to that machine, and its
`invalidatedProjectIds` fan-out is untouched. A test pins this so a later cleanup pass
cannot narrow it by accident. Viewer-key routes in `automationRoutes.ts` were already
project-scoped and were not touched.

**R4 — contracts preserved.** Transactions, ownership/`claimToken` checks, claim and
revision semantics are untouched; the only service change is *what is returned*.
Response payloads gain an additive `projectId` (and `affectedProjectIds` on ack). The
CLI types these callback values as `unknown` and parses them without a strict schema
(`packages/happy-cli/src/api/apiMachine.ts`), so additive fields are safe; returning
`projectId` on the wire also follows the precedent already set by
`session-followup-deliver`.

### Tests

Red was observed before each implementation step (6 service failures, then 5 handler
failures). New regressions:

`automationExecutionService.spec.ts`
- reports the affected projects of the acknowledgements that actually advanced
- reports no affected project when every acknowledgement is a no-op
- does not trust a repeated automation id for more affected projects than rows changed
- names the authoritative project of a claimed / started / reported run

`automationSocketHandler.spec.ts`
- invalidates only the projects the acknowledgement actually advanced
- emits nothing for an acknowledgement that changed no automation
- emits nothing when an acknowledgement fails
- scopes a claimed / started run to the project the service resolved
- scopes a reported run to its project and stays silent on an idempotent replay
- keeps the machine-key rotation account-wide

Assertion strength was checked by mutation (AGENTS/CLAUDE §1.13), each caught:
1. delete the `if (idempotent) return;` guard → 1 failure;
2. treat every acked item as advanced → 2 failures;
3. drop the `machineAccountId`/`machineId` scoping from the project lookup → 1 failure.

Five run fixtures in `automationExecutionService.spec.ts` and one in
`automationSocketHandler.spec.ts` were stale — they mocked a run without the
`automation` relation that `claimedRun()` actually includes, or a report result without
`projectId`. They now match the real query shape. No production fallback was added for
the "missing relation" case, because the relation is non-nullable in Prisma; inventing a
silent account-wide fallback there would have re-created the bug it hides (§1.13).

### Verification

- `pnpm typecheck` (tsc --noEmit): clean.
- `pnpm build` (typecheck + runtime bundle): clean.
- Targeted: `automationExecutionService.spec.ts` + `automationSocketHandler.spec.ts`
  → 53/53 pass.
- Full server suite: **1386 passed, 21 failed, 509 skipped**. All 21 failures are in
  `sources/app/automation/scriptRegistrationService.spec.ts` and are **pre-existing in
  this worktree**, proven by restoring the four files to their `HEAD` contents and
  re-running that file — identical 21 failures. They fail in `beforeEach` at
  `client.project.create` with `Inconsistent column data: Conversion failed: expected a
  string or an array in column 'automationViewerPublicKey'`, i.e. a PGlite/Prisma
  adapter mismatch in this environment (`pnpm install` warned
  `pglite-prisma-adapter … unmet peer @prisma/client@">= 7.1.0": found 6.19.2`).
  Nothing in this change touches script automations.

### Limitations / not done

- **Not committed.** The mandatory checks pass, but the working tree cannot be proven
  fully green while the 21 pre-existing `scriptRegistrationService` failures stand, so
  the change is left staged in the worktree for the primary agent to review first.
- **No runtime/production verification.** This is local implementation only; the
  surge reduction is reasoned from the code path, not measured against production.
  The spec itself notes the exact initiating automation is not established, so this
  removes a known multiplier — it is not proof that the multiplier was *the* cause.
- **Desktop is unchanged** and still treats `projectId: null` as account-wide. That is
  intentional per the plan (Desktop coalescing is a parallel track); server-first
  deployment already helps existing clients.
- **Worktree setup** required `pnpm install --filter ./packages/happy-server...`,
  `prisma generate`, and building `packages/happy-wire` (`pnpm -C packages/happy-wire
  build`) before vitest could run. `node_modules` was absent.

## Primary Codex review

Reviewed the four-file implementation diff against authoritative service queries and existing recipient helper. Ownership/claim guards remain before project IDs are returned; ACK lookup is limited to rows actually advanced in the transaction; repeated reports do not emit; true machine-key change compatibility is retained. No additional blocking finding in this track. Independently ran service, socket, and project-recipient tests: 55/55 passed. Full-suite baseline limitation above remains.

## 커밋·PR 준비 (2026-09-17)

사용자의 `commit & pr` 요청에 따라 변경을 저장소별 커밋·브랜치 push·main 대상 PR로 인수인계한다. 앞선 무커밋/무push 기록은 당시 상태다. 머지·배포는 수행하지 않는다. 기존 전체-suite 실패는 PR에 명시한다.
