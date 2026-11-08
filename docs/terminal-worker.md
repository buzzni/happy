# Terminal workers — terminals that outlive the daemon

Spec: `specs/terminal-survive-runner-restart/` (aplus Desktop has the paired spec of the same name).
Code: `packages/happy-cli/src/daemon/terminalWorker/`.

## Why

A remote terminal's PTY used to live inside the daemon. Every daemon restart — a pin update, an app
update, a crash — closed the user's shells, dev servers and tmux with it. A terminal worker is a
detached process that owns the PTYs instead; the daemon talks to it over a socket, and the next
daemon adopts it.

## Turning it on (staged rollout)

| `HAPPY_TERMINAL_WORKER` | This release | After the default flips (later pin) |
|---|---|---|
| `1` | on (opt-in) | on |
| `0` | off — kill switch | off — kill switch |
| unset / anything else | **off** (in-daemon PTYs, as before) | on |

The default is one constant, `TERMINAL_WORKER_DEFAULT_ENABLED` in `survivalDecision.ts`. Windows never
uses workers. A daemon with workers off advertises nothing (Desktop behaves as before) and, at start,
closes any worker an earlier daemon left, so "off" always converges to no workers.

## Process model

```
daemon ──spawn(detached, own session, cwd=$HOME)──► happy terminal-worker --record-id <uuid>
   ▲                                                   │  prints `ready <socket>` once listening
   └── owner-only unix socket, hello{secret} ◄─────────┘  writes $HAPPY_HOME_DIR/terminal-workers/<uuid>.json (0600)
```

- One controller at a time: the newest authenticated connection takes the worker over.
- The worker numbers each terminal's output (seq) and keeps the same bounded replay buffer the
  daemon keeps; the daemon mirrors it. A client resumes with the same seq before and after a restart.
- Only direct (same-machine WebSocket) terminals open in a worker. Relay terminals stay in the
  daemon: the server ends them when the daemon's socket drops (follow-up spec
  `terminal-survive-relay-restart`).
- A v2 terminal's key and daemon nonce are held in the worker's memory only, so an adopting daemon
  rebuilds the same frame keys. They are never written to disk.

## Protocol

Frames: 4-byte big-endian length + UTF-8 JSON, at most 16 MiB.

**Frozen envelope** — never changes, so any daemon can close any worker: the frame format,
`hello {secret, protocolVersion}` → `helloAck {pid, protocolVersion, cliVersion}`,
`request {requestId, op, args}` → `response {requestId, ok, result|error}`, and the ops `list`
(`{terminals:[{id,pid,exited}]}`) and `shutdown`.

Version 1 ops: `create`, `write`, `inject`, `resize`, `signal`, `terminate`, `dump`, `setMeta`,
`forget`; events `output {id,seq,data}` and `exit {id,code,signal}`. A daemon adopts only workers of
its own `TERMINAL_WORKER_PROTOCOL_VERSION` and shuts the others down with the frozen `shutdown`.
Before a restart keeps terminals, the daemon reads the installed bundle's `package.json` field
`happyTerminalWorkerProtocol` (not by running it: a bundle from before workers would take an unknown
subcommand for a session to start); anything but its own version closes them (`incompatible`).
Bump that field together with `TERMINAL_WORKER_PROTOCOL_VERSION` — a unit test holds them equal.

## What a restart does

| Case | Worker terminals |
|---|---|
| restart drain (`bundle-replaced`, `version-mismatch`, `desktop-version-match`, `app-update`, `env-reapply`, `user-restart`, SIGHUP), incl. `daemon stop --for-restart` | kept |
| restart drain `account-switch` | closed |
| `happy daemon stop`, stop drain, SIGTERM, SIGINT | closed |
| crash, uncaught exception | kept (the worker carries on) |
| installed protocol differs / unknown, unreadable record | closed |

The drain publishes this from its start as `daemonState.lifecycle.terminals` (`keep`/`close`) and
`terminalsCloseReason`. A kept terminal in use does not hold the drain up (`busyTerminalCount` counts
only terminals that will close).

## Starting daemon: adopt or retire (fail-safe)

The only signal a daemon ever sends a worker is a request over a socket the worker authenticated
with its secret. Per record:

| Finding | Action |
|---|---|
| record unreadable | left alone, path logged, next drain closes (`record-unreadable`) |
| another boot | record retired, no signal |
| pid gone, or alive with another start time (pid reuse) | record retired, no signal |
| alive but the socket does not answer | nothing (retried next start) |
| answers, other protocol (or workers off) | frozen `shutdown` |
| answers, same protocol | adopted; it only drains (no new terminals) — new shells open on this daemon's own worker, with this daemon's environment |

Adopted direct terminals are registered under their old session id with the detach grace (30 s)
counted from adoption; the app re-attaches within it.

## A worker's own lifetime

It closes its terminals and exits when: no controller arrived within 30 s of start and it has no
terminal; it has no live terminal and no controller; its record file disappeared (checked every
10 s); or it has had no controller for 24 h. SIGTERM/SIGINT close; SIGHUP is ignored.

## Not to be killed by mistake (process ledger)

- `happy doctor` lists workers as `terminal-worker` and `doctor clean` never targets them.
- Workers are never in `trackedSessions`, so the session reapers do not see them.
- Desktop's helper ledger (ADR-041) matches the daemon by its CLI entrypoint; a worker's command
  line (`… terminal-worker --record-id …`) is excluded from that match on the Desktop side.
- Identity marker: `HAPPY_TERMINAL_WORKER_RECORD_ID` in the worker's own environment (not inherited
  by shells).

## Diagnostics

`daemonState.terminalSurvival = {version:1, workers:{current,draining}, workerVersion?, lastAdoption?}`
(counts only) and a `Terminal workers:` line in `happy daemon status`. Worker log:
`$HAPPY_HOME_DIR/logs/terminal-worker.log`.

## Recovery

Unset `HAPPY_TERMINAL_WORKER` (or set `0`) and restart the daemon: it closes any leftover worker at
start. Deleting `$HAPPY_HOME_DIR/terminal-workers/` makes each worker close its terminals and exit
within 10 s.
