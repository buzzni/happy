# Codex Turn Timeout Lifecycle Recovery Plan

**Goal:** Prevent an active long-running Codex turn from being reported as aborted and prevent its later real completion from being discarded.

**Architecture:** Keep lifecycle authority in `CodexAppServerClient`. The timeout becomes an inactivity watchdog refreshed only by turn-progress notifications. When inactivity truly expires, Happy requests a real provider interrupt and uses the existing restart fallback; it does not synthesize a terminal marker while the provider can still emit turn activity.

**Scope:** `packages/happy-cli/src/codex/codexAppServerClient.ts` and its focused Vitest suite. No wire schema, external dependency, or public session-protocol change.

## Tasks

- [x] Replace the regression that accepts `timeout -> late normal completion is ignored` with tests proving active progress extends the watchdog and a real timeout interrupts the provider.
- [x] Store the watchdog with the pending turn and refresh it from relevant raw/legacy turn progress.
- [x] Route inactivity expiry through `abortTurnWithFallback` instead of inserting the turn into `completedTurnIds` or directly emitting `turn_aborted`.
- [x] Run the focused Codex client test, Happy CLI typecheck, and unit suite.

## Risks

- Unrelated notifications must not keep a dead turn alive. Only provider turn/item/token/diff notifications refresh the watchdog.
- A timeout/real-completion race must produce one terminal event. Existing turn-id dedupe remains authoritative after an actual provider terminal or forced restart.

## Verification

- `corepack pnpm -C packages/happy-cli exec vitest run --project unit src/codex/codexAppServerClient.test.ts`: 24 tests passed.
- `corepack pnpm -C packages/happy-cli test`: build/typecheck passed and 1,124 tests passed. The command remains red because 14 unrelated `src/claude/runClaude.test.ts` cases use a `@/persistence` mock that does not export `SandboxConfigSchema`; the same 14 fail on this branch's parent, so they are not caused by this change.

## Review Follow-up

- [x] Correlate activity notifications with the pending thread/turn before refreshing the inactivity watchdog, so late events from an older turn cannot keep a dead current turn alive.
- [x] Replace real-time timeout sleeps with Vitest fake timers while preserving both the activity-extension and stale-turn timeout regressions.
- [x] Hold the watchdog disarmed while a server → client approval request is outstanding. Approvals arrive as JSON-RPC requests, not notifications, so they never reached `recordPendingTurnActivity`; a turn blocked on a mobile approval prompt was interrupted after the inactivity window even though the provider was waiting on us. Answering the request re-arms the watchdog with a full window, and `disconnectInternal` drops the counter so approvals belonging to a dead process cannot leave a later turn unguarded.
- [x] Document on `sendTurnAndWait` that `turnTimeoutMs` bounds inactivity rather than total turn duration.
