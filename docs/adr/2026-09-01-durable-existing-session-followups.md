# ADR: Durable existing-session follow-up actions

- Status: Accepted
- Date: 2026-09-01
- Owners: happy-server, happy-cli daemon, happy-wire

## Context

Desktop's self-review loop used renderer state to notice the end of an agent turn and send the next review prompt. Closing Desktop therefore stopped the loop even though the target machine's daemon stayed online. The server-backed automation control plane already provides the required ownership, key fencing, machine targeting, durable changes, and daemon claim pattern, but scheduled automations create or wake runs rather than append a bounded prompt to one existing E2EE session.

The server must not decrypt or persist review findings. Only the daemon that owns the session encryption key may inspect the response and decide whether another prompt is needed.

## Decision

Introduce a separate, versioned `SessionFollowup` aggregate rather than adding Desktop-specific state or overloading interval/daily/GitHub schedules. The outer action is general-purpose (`existing-session-prompt`); its evaluator is a versioned discriminator (`review-findings-v1`).

The aggregate state machine is:

```text
WAITING --daemon CONTINUE--> DELIVERY_PENDING --seq CAS + insert--> WAITING
   |                              |
   +-- clean/low/error/max ------>+-- user/generation race -------> COMPLETED/FAILED
   +-- pause -----------------------------------------------------> PAUSED
PAUSED --resume + generation++------------------------------------> prior executable state
executable/paused --stop/delete + generation++--------------------> CANCELLED/tombstone
```

The server owns:

- project/editor authorization and the immutable account, machine, project, and session target;
- `revision` for Desktop mutations, `generation` for cancellation fences, and `step` for daemon work fences;
- total/current rounds, response/observation cursors, pause/cancel/completion state;
- expiring, hash-only claim tokens and a machine-targeted change/tombstone log;
- deterministic pending message IDs and the expected session sequence;
- safe history kinds and terminal codes only.

Permission and execution-target changes are generation fences, not eventual
checks. Removing or downgrading the initiating editor, changing the project's
machine/workspace target, or rotating either automation key invalidates active
follow-ups in the same serializable transaction and records only a safe terminal
code. Claim, evaluation, and final delivery also revalidate the current project
owner/member role, configured machine, and key versions.

Viewer-key `replace-if-unused` treats every non-deleted follow-up as a key
consumer, just like a non-deleted scheduled automation. An explicit rotation
still generation-fences active follow-ups; the conditional bootstrap endpoint
must never rotate a key out from under one.

The aggregate keeps machine account/ID values for audit and targeted changes,
but deliberately has no foreign key to `Machine`: deleting a machine must not
discard follow-up history or regress the existing machine-delete API. Execution
re-resolves that composite target and fails closed if it no longer exists.
Project deletion writes machine-targeted follow-up tombstones before the project
cascade removes the aggregate, matching the scheduled-automation lifecycle.

The daemon owns:

- payload and session-message decryption;
- target validation of the encrypted payload directory against the locally tracked session directory (see the 2026-09-02 amendment);
- agent-turn completion and explicit user-intervention detection;
- parsing the last structured review JSON and mapping it to `CONTINUE` or a safe terminal code;
- encrypting the next prompt and resuming the same local session when required.

## Exact-once continuation

`CONTINUE` reserves `happy-followup:<followup-id>:<generation>:<next-round>` and advances `step`. Delivery must re-claim that exact generation/step. The daemon first makes the local session consumer ready; only then does it invoke the final delivery fence. In one serializable server transaction, delivery:

1. verifies account, machine, key versions, generation, step, claim, status, expected sequence, and deterministic local ID;
2. compares and increments `Session.seq` only if it still equals `pendingExpectedSeq`;
3. inserts one encrypted `SessionMessage` under the session-scoped unique local ID;
4. advances the round and response boundary and writes change/history rows.

An existing session/local-ID pair makes a retry idempotent. A sequence mismatch terminates as `USER_INTERVENTION`. Serializable transaction retry makes a concurrent stop, pause, delete, or generation change linearizable with delivery. Claim expiry permits another daemon instance to resume after process or network failure without weakening the generation/step fence.

Daemon session startup also uses the existing per-session in-flight resume
fence, so a follow-up tick racing an interactive/recovery resume shares one
child launch rather than attaching two processes to the same session.

The daemon retains an in-memory change cursor and executable map so normal ticks consume only deltas. The cache is not correctness-critical: a daemon restart reconstructs it from sequence zero, and the generation/step fences still prevent a delivered round from repeating.

Sync pages include an explicit `hasMore` bit computed with a `limit + 1` query. The daemon executes nothing until it has consumed the complete targeted change stream, and a stalled or regressing cursor fails closed. Session-message pagination follows the same fail-closed rule, so a safety limit or stalled cursor can delay work but can never evaluate a partial response or stale generation.

## Review contract and fail-closed behavior

The decrypted final agent response must be a JSON object (raw or a single JSON fence). `findings` is interpreted as follows:

- any `medium` or `high`: continue only if `currentRound < totalRounds`;
- only `low`/`nit`: `LOW_OR_NIT_ONLY`;
- absent, null, or empty findings: `CLEAN`;
- malformed JSON, a non-array findings value, or an unknown severity: `UNSTRUCTURED`;
- no remaining round: `ROUNDS_EXHAUSTED`.

Decryption, session lookup, permission revocation, and target failures terminate safely. A user message after `responseBoundarySeq` terminates as `USER_INTERVENTION`. No evaluation request carries response text or findings.

## Security and data handling

The action payload contains the follow-up prompt and expected directory, encrypted once with a random DEK. The server stores ciphertext plus separate envelopes for the project viewer key and target machine key. Session messages remain normal E2EE ciphertext. Claim tokens are stored only as SHA-256 hashes.

Server history may store an optional encrypted detail in the future, but this version always writes `detailCiphertext = null`. Server-visible terminal codes, rounds, cursors, IDs, and timestamps contain no review body or credentials. Machine sync excludes the viewer envelope. A target machine must match the server-bound account/machine and the locally tracked session before messages are read or sent.

## Wire and capability versions

- `AUTOMATION_PROTOCOL_VERSION = 4`
- `AUTOMATION_SESSION_FOLLOWUP_PROTOCOL_VERSION = 4`
- `SESSION_FOLLOWUP_WIRE_VERSION = 1`
- automation target capability: `sessionFollowupSupported: boolean`
- daemon machine metadata: `automationSupport.sessionFollowup: true`

Desktop must first call `GET /v1/projects/:projectId/automation-target` and require `target.sessionFollowupSupported === true`. It uses the returned machine/viewer public keys with `encryptSessionFollowupPayload`; Desktop never sends plaintext prompt content to the server.

## Desktop REST and socket contract

Start:

```http
POST /v1/projects/:projectId/session-followups
```

```json
{
  "wireVersion": 1,
  "sessionId": "...",
  "totalRounds": 2,
  "currentRound": 1,
  "responseBoundarySeq": 42,
  "payloadVersion": 1,
  "payloadCiphertext": "base64...",
  "viewerKeyId": "...",
  "viewerKeyVersion": 3,
  "viewerKeyEnvelope": "base64...",
  "machineKeyVersion": 4,
  "machineKeyEnvelope": "base64..."
}
```

The encrypted payload before encryption is:

```json
{
  "kind": "existing-session-prompt",
  "directory": "/canonical/project/path",
  "prompt": "Return the next review as structured JSON...",
  "evaluator": { "kind": "review-findings-v1" }
}
```

Control and query endpoints:

```text
GET    /v1/projects/:projectId/session-followups?session_id=:sessionId&limit=20
GET    /v1/projects/:projectId/session-followups/:followupId
GET    /v1/projects/:projectId/session-followups/:followupId/history?limit=50
POST   /v1/projects/:projectId/session-followups/:followupId/pause
POST   /v1/projects/:projectId/session-followups/:followupId/resume
POST   /v1/projects/:projectId/session-followups/:followupId/stop
DELETE /v1/projects/:projectId/session-followups/:followupId
```

Pause/resume/stop/delete bodies are `{ "wireVersion": 1, "expectedRevision": <latest revision> }`. A revision conflict returns HTTP 409 with `{ "error": "revision-conflict", "latest": <SessionFollowupPublic> }`.
Delete is also valid for a terminal row: it preserves the existing outcome in
safe history, writes a tombstone, and releases that row's viewer-key usage.

`SessionFollowupPublic` exposes identity, `revision/generation/step`, status/terminal code, round counts, response/observation cursors, encrypted viewer fields, machine key version, and timestamps. It never exposes a pending prompt, decrypted review, claim, credential, or machine envelope. Desktop should use `createSessionFollowupApiClient` and the exported Zod schemas rather than duplicate DTOs.

The existing user socket event `automation-updated` with `reason: "sync"` invalidates Desktop state after start/control/daemon transitions. Follow-up invalidations are fanned out to the project owner and every accepted member because an editor may own the action while the daemon socket belongs to the project owner's machine account. Desktop then refetches list/item/history; it does not participate in response watching or continuation delivery. The daemon-only socket RPCs are `session-followup-sync`, `session-followup-claim`, `session-followup-evaluate`, and `session-followup-deliver`.

## Migration and rollout

Migration `20260901090000_add_session_followups` creates the aggregate, durable change log, history, enums, fences, indexes, and the database round constraint. Its rollback removes them in dependency order. Server-backed automation rollout gating is reused; unsupported daemons are rejected before creation. Existing schedule/GitHub/session execution schemas and routes are unchanged apart from the additive protocol/capability field.

## Consequences

Desktop can exit completely after starting the action. The server and daemon continue safely through daemon restarts, claim retries, and temporary disconnects. The cost is a dedicated aggregate and daemon execution path, which keeps scheduled-run semantics stable and makes the E2EE boundary explicit.

## Amendment 2026-09-02: no project-workspace binding

The original design required `project.config.workspaceDir` at creation and made
the daemon demand `workspaceDir == payload.directory == session.directory`.
In production that invariant never held: Desktop only writes `workspaceDir`
for projects created from an existing folder (0 of 50 projects had one), and
worktree sessions run outside the project root by design. Every follow-up
start was therefore rejected with `automation-target-unavailable` after
Desktop had already sent round 1, so the loop stopped after a single round.

Decision: creation no longer requires `workspaceDir` (scheduled automations
never did), and the daemon binds only on the tracked session directory
matching the payload directory. `projectWorkspaceDir` stays in the daemon view
for wire compatibility but is no longer consulted. The lost check was only a
weak cross-project heuristic — the server has no session→project link, and an
editor can already run arbitrary prompts on the target machine — so the
authorization boundary is unchanged: project editor role, machine ownership,
key versions, and an active session owned by the machine account.

## Amendment 2026-09-03: daemon self-upgrade must not pause follow-ups

After the 2026-09-02 fix shipped, follow-ups still froze at "round N of M".
The daemon heartbeat detects a replaced `dist/index.mjs` (any `npm i -g` on
the machine) and waits to hand off to the new bundle until runtime activity
is zero; while waiting it paused every automation runner, including the
session follow-up tick. Interactive sessions live for hours, so on a machine
with long-running sessions the runners stayed paused indefinitely and server
rows sat in `WAITING` with `lastObservedSeq == responseBoundarySeq`.

Decision: while active sessions defer the handoff, automations keep running.
The runners are paused only when the sole remaining blockers are in-flight
automation ticks or leases, i.e. when the handoff is imminent. The daemon
therefore keeps serving follow-ups on the old bundle until the machine is
idle; the cost is that a spawn started in that window runs the old CLI,
which was already true for interactive sessions.
