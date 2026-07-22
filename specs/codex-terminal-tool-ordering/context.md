# Context

## 2026-07-22 — Planning

- Production trace: `commandExecution` began at 16:53:22 KST, but Codex
  emitted final text and `turn/completed` at 16:54:28. The command completion
  arrived at 16:58:22.
- Current `CodexAppServerClient.emitRawTurnCompletion()` emits terminal events
  immediately; `mapCodexMcpMessageToSessionEnvelopes()` then clears
  `currentTurnId`, so the late `tool-call-end` has no session turn ID.
- Chosen fix: defer terminal emission in the CLI client until all raw
  `commandExecution` items for that provider turn complete.

## 2026-07-22 — Completed

- Added `openCommandExecutionTurns` and a single deferred raw terminal event to
  `CodexAppServerClient`.
- `item/completed(commandExecution)` emits `exec_command_end`, removes the
  command from the open set, then flushes the deferred terminal event only
  when no matching commands remain.
- Added a regression test covering:
  `command start → final answer → thread idle → failed turn completed → command completed`.
  It proves fallback terminal signals do not finish the turn early, the
  authoritative provider status/error wins, and `sendTurnAndWait()` remains
  pending until the command end is emitted.
- The regression also maps the emitted events through the session-protocol
  mapper and verifies `turn-start → tool-call-start → tool-call-end → turn-end`
  share one session turn ID.
- Review found that a stale `turn/completed` arriving while the current turn's
  terminal event was deferred could overwrite that deferred event. The pending
  turn guard now runs before storing or replacing deferred completion state;
  the regression includes the stale event after the authoritative current-turn
  completion.
- Verified with:
  `corepack pnpm -C packages/happy-cli exec vitest run --project unit src/codex/codexAppServerClient.test.ts src/codex/__tests__/sessionProtocolMapper.test.ts --reporter=dot`
  (48 passed), `corepack pnpm -C packages/happy-cli exec tsc --noEmit`, and
  the full unit suite (136 files, 1,234 tests passed).
- The build still reports pre-existing pkgroll warnings for package `bin`
  entries outside `dist` and empty chunks; they do not fail validation and are
  unrelated to this change.
