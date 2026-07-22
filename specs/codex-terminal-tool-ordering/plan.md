# Plan

## Phase 1 — Event ordering contract ✅ Done

1. Add a failing raw-notification test for:
   `commandExecution started → final answer → turn/completed → commandExecution completed`.
   Verify no terminal event precedes `exec_command_end`.
2. Track open command IDs against the active provider turn in
   `CodexAppServerClient`.
3. Buffer the terminal notification while commands remain, then flush it after
   the final command completion. Preserve duplicate and stale-turn handling.
4. Run focused unit tests and `typecheck`; update context with outcomes.

## Phase 2 — Review and delivery ✅ Done

1. Verify fallback terminal signals (`final_answer`, thread idle) cannot bypass
   open-command deferral.
2. Preserve the authoritative status/error from `turn/completed` when it
   follows an earlier fallback signal.
3. Verify the mapped session envelopes retain one turn ID through
   `tool-call-end` and `turn-end`.
4. Run the full Happy CLI unit suite and TypeScript check before delivery.

## Approval

Implementation is authorized by the user request on 2026-07-22, subject to
the Red → Green → Refactor sequence above.
