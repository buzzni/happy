# Codex terminal/tool event ordering

## Goal

When Codex app-server reports a terminal turn state before a started
`commandExecution` item has reported completion, Happy CLI must preserve a
single, ordered session-protocol turn:

```text
turn-start → tool-call-start → tool-call-end → turn-end
```

## Requirements

1. A `task_complete` or `turn_aborted` event for a provider turn with open
   command executions is deferred until every command has completed.
2. The emitted `tool-call-end` and final `turn-end` envelopes retain the same
   Happy session turn ID as their `tool-call-start` envelope.
3. `sendTurnAndWait()` resolves only after the deferred terminal event is
   emitted.
4. Existing terminal-event de-duplication and cross-turn guards remain intact.
5. A command completion event must continue to be emitted to existing CLI
   consumers exactly once.

## Scope

- `packages/happy-cli/src/codex/codexAppServerClient.ts`
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts` only if needed
  to preserve the session turn association
- Focused unit tests for raw Codex app-server notifications.

## Non-goals

- Changing Codex app-server's own event order.
- Cancelling a provider command that outlives its turn.
- Changing web-client activity indicator behavior.
