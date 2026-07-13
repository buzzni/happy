# Follow-up: CLI can miss the `archived` ephemeral if disconnected at archive time

Status: **open** (deferred from the session-404-retry-loop fix)
Severity: low (lingering idle process, not a resource-burning retry loop)

## Context

The session-404-retry-loop fix makes a running CLI shut down when its session is
archived/deleted server-side, via two paths:

1. **Archive (row kept, `active=false`)** — the server emits a session-scoped
   `activity` ephemeral with `reason: 'archived'`; the CLI exits on it
   (`packages/happy-cli/src/api/apiSession.ts`, ephemeral handler).
2. **Delete (row gone)** — the message sync hits a 404, backoff classifies it as
   non-retryable and throws, `InvalidateSync` stops and calls `onSyncFatal`,
   which tears the session down
   (`packages/happy-cli/src/utils/{time,sync}.ts`, `apiSession.onSyncFatal`).

## The gap

Path (1) relies on an **ephemeral**, which is transient and not persisted/replayed.
If the CLI's socket is disconnected at the exact moment the session is archived,
it never receives the `reason: 'archived'` ephemeral and never exits.

Because archive keeps the row (`active=false`), the message endpoints do **not**
404, so path (2) does not fire either. Net effect: the CLI process **lingers idle**
until it is otherwise stopped. No 404 flood, no wasted network/CPU — just a stale
process.

This is **not a regression** — before the fix this same situation would have led
to the retry flood; now it merely lingers. It is a pre-existing limitation of the
chosen (ephemeral) signalling mechanism.

## Proposed fix (when prioritized)

On reconnect, after the message catch-up completes, re-check the session's
server-side lifecycle state and exit if it is no longer active. Options:

- Read `active` from the session record during the reconnect/catch-up handshake
  and, if `false`, run the same graceful shutdown (`emit('archived')`).
- Or have the server include the current `active`/lifecycle state in the
  reconnect/catch-up response so the CLI does not need an extra round-trip.

Touches the reconnect + catch-up path (`apiSession.ts` `connect` handler and the
receive/catch-up flow), which is delicate — hence deferred to its own change with
dedicated tests rather than bundled into the retry-loop fix.

## Decision

Ship the retry-loop fix first (it fully resolves the observed incident: a single
dead session producing ~757k 404 retries / ~90MB of logs). Revisit this
ephemeral-miss edge case as a separate change once production confirms how often
disconnect-at-archive actually coincides.

## Related smaller gaps (also deferred)

- **Offline-start session swap loses the `archived` listener.** The Codex /
  Gemini / OpenClaw / ACP runners attach their `session.on('archived', ...)`
  listener once, to the session in hand at startup. If the runner started
  offline (stub session via `setupOfflineReconnection`) and later swapped to a
  real session, the listener is not re-attached to the swapped session. Narrow
  window (offline start + later server-side archive), and Gemini's queued-swap
  logic makes threading the listener through `onSessionSwap` non-trivial — do
  it together with the reconnect-recheck fix above.
- **`presence/timeout.ts` emits no `reason` and stays user-scoped-only.** The
  idle-timeout job flips `active=false` without notifying the session-scoped
  socket. This is fine today: the timeout only fires after ~10 min without
  keepalives, i.e. when the CLI is dead or disconnected — a session-scoped
  ephemeral would have no one to reach anyway. Noted so nobody "fixes" it into
  archiving live sessions.
