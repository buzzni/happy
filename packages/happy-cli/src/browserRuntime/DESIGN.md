# Browser Runtime (Agent Browser PoC)

Plan/spec: Saydo `specs/agent-browser-poc/` (spec, plan, contracts, acceptance).
This file records the implementation decisions made at T01 and the module
boundaries. `contracts.ts` is the typed version of the plan's contract.

## T01 findings that shaped this

- Agent sessions are spawned by the Happy daemon as detached children
  (`daemon/run.ts` spawnSession). Nothing aborts a turn when the Desktop client
  disconnects; only abort/stop/archive/idle-reaper end it. Follow-up messages go
  through the server (`POST /v3/sessions/:id/messages`, `happy agent prompt`).
- Existing `mcp__happy__browser_*` tools go session MCP → daemon `/browser/request`
  → extension WebSocket. A missing `tabId` falls back to the active tab inside
  the extension (`protocol.js` resolveTab).
- No SQLite dependency; durable state elsewhere uses temp-file + fsync + rename
  + directory fsync (`checkpoint/checkpointTurnApplyJournal.ts`). `node:sqlite`
  is unavailable on the supported Node 20 floor, so TaskStore reuses that
  pattern (no new dependency).
- Agents are not sandboxed by default and can read `~/.happy`. Runtime secrets
  therefore never live under `~/.happy` and never on the agent's host
  filesystem: the Runtime, Chromium, profile and journal run in Linux
  containers; the host only holds an agent grant (whose power equals the agent
  tool surface) and the harness issuer key under a harness-only directory.

## Topology (PoC substitute for "separate Linux execution machine")

```
macOS host (execution machine H' + client C on the same box — see results)
  Happy daemon + real agent session (claude)       Desktop (Electron) = client C
     │ MCP tools browser_task_* (agentTools.ts)        │ console / approve / takeover
     ▼                                                 ▼
  127.0.0.1:<runtime-port> ── HTTP JSON (bearer grant / interactive capability)
  ┌──── docker networks abp-<runId>-a / -b (OrbStack Linux), one per browser ────┐
  │ runtime container: node runtimeMain (TaskStore volume, writer lock)   │
  │    └─ CDP over ws ─► browser container(s) per profile:                │
  │         Xvfb + Chromium (--remote-debugging-port, internal only)      │
  │         + noVNC (published 127.0.0.1) + browserInstanceId file        │
  │ fixture container: site A (a.poc-one.test), site B (b.poc-two.test), │
  │    control/ledger API (harness token), barrier                        │
  └───────────────────────────────────────────────────────────────────────┘
```

## Modules (src/browserRuntime)

| File | Responsibility | Must not |
|---|---|---|
| contracts.ts | IDs, DTOs, error codes, limits, driver port, API port | I/O |
| taskStore.ts | durable task/action/approval/event records, dedupe, seq, writer lock + fencing, quota | know about CDP |
| stateMachine.ts | pure transition rules (status × event → status), pause reasons | I/O |
| inputLease.ts | per-tab owner/epoch/segment, profile-wide user fence | persist by itself |
| policy.ts | origin allowlist, fixture action risk classes, approval binding hash, redaction | trust page text |
| auth.ts | grant/capability sign+verify, revocation list | accept identity from request JSON |
| runtime.ts | BrowserRuntimeApi: all operations, batch worker, cancel fence, recovery | hold a lock across driver awaits |
| drivers/cdpDriver.ts | explicit target CDP driver, OOPIF, refs, screenshot, trusted input | active-tab fallback, Runtime.evaluate exposure |
| server.ts / runtimeMain.ts | HTTP transport, health, single instance | business rules |
| agentTools.ts | MCP tool surface for the agent (claude/utils/startHappyServer wiring) | approve/takeOver |

Harness and fixture: `scripts/browser-poc/` (fixture server, container images,
runner, A01–A12 scenarios). Unit tests next to modules (`*.test.ts`, unit
project). Browser E2E suites are `src/browserRuntime/e2e/*.poc.test.ts` in the
`browser-poc` vitest project (needs docker).

## As built (2026-09-25)

- Each browser container sits on its own network (`abp-<run>-a` / `-b`); the Runtime and
  the fixture join both, so a browser or page can never reach the other profile's CDP.
  The CDP proxy accepts only `Host: browser-<profile>:9223`; noVNC needs a per-run password.
- Owned tabs are opened as background windows (a background tab in the user's window is
  hidden in a headful browser and cannot be captured). Cost: per-window browser UI memory
  (see Saydo results, A12 soak).
- Refs resolve only against snapshots the agent received; dispatch-time checks use
  `describeRef` (no new snapshot). Approvals persist a structural element identity so a
  pending approval survives a Runtime-only restart when document and node are unchanged.
- Writer lock = heartbeat lease (5 s refresh, stale after 20 s) + fencing token;
  `runtimeMain` waits for a dead writer's lease to expire before giving up.
- Acceptance results, gates and the No-go verdict: Saydo `specs/agent-browser-poc/results.md`.

## Deployment readiness (S2, 2026-09-25)

Saydo `specs/agent-browser-deploy/` D3 (verify), D4, D8, D9, D10 (Runtime side).

- Modes: without `ABP_CONFIG_FILE` the Runtime runs exactly as the PoC harness (abp1 keys file,
  TCP admin with bearer). With `/etc/abp/runtime.json` (`runtimeConfig.ts`, schema-validated)
  identity, profile owners (`profiles[].principalId`) and `trustedIssuers` come from the file.
  `authMode: "production"` accepts interactive capabilities only as `abp2` (Ed25519, `aud` =
  machineId, `iss` = saycode-server, lifetime ≤ 5 min), keeps internally minted abp1 agent
  grants, creates the agent key inside the state volume, and serves admin on a 0600 unix socket.
- Broker (`broker.ts`, `/run/abp/broker.sock` 0660): the daemon registers at spawn (the Happy
  session id does not exist yet), binds the registration when the session reports its id, and
  revokes it at exit; session processes get 55-minute grants with their per-session secret
  (`brokerGrantSource.ts`) and renew 5 minutes early. `GET /v1/attention` serves the outbox.
  Registry changes, issuance and revocation are serialized after the request body is read.
  Revocation persists a `revoking` tombstone (issuance blocked, grant ids kept), revokes each
  grant, then drops the registration; start-up finishes interrupted ones. The daemon keeps
  unconfirmed revocations in `~/.happy/browser-task-revocations.json` and retries them with
  backoff (≤ 5 min), across restarts.
- Attention outbox (`attention.ts`): transitions are tagged `data.attention` at commit time
  (approval decided, takeover released, user resume, recovery); the outbox observes TaskStore
  commits and `reconcile()` repairs a crash between the task commit and the outbox write.
  Readers see only sequences already on disk (a failed write is retried), so repair never
  reassigns a sequence the daemon acknowledged. A per-task `unresolved` index, independent of
  the 1,000-event retention, feeds the `CURSOR_EXPIRED` snapshot. Expiry: `afterSeq + 1 < oldestSeq`.
- User resume (D8): interactive `resume` only from `user-input-complete`, and only while the
  task's stored grant is valid; approval waits, uncertain writes, cancel requests and
  browser replacement are never released by the user. The final write rechecks task state,
  grant validity and input ownership, since the login check awaits the browser.
- Writer lock (D9): the image entrypoint runs `exec flock -n -E 75 -F <state>/runtime.flock node`;
  production refuses to start unless `/proc/locks` shows this pid holding it. The heartbeat
  lease and fencing token stay. The Runtime runs as uid 10870 (no host login user).
- Production start (`privilegeDrop.ts`): the installed permissions are `/etc/abp/runtime.json`
  root 0600 and `/run/abp` root:abp-session 0750, so the container starts as root with only
  SETUID/SETGID (`--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID
  --security-opt no-new-privileges`). The entrypoint creates the state dir and lock file as the
  runtime user; node reads the config, binds broker (root:abp-session 0660, group by
  membership) and admin (root 0600) sockets, then drops to `ABP_RUNTIME_UID/GID` and exits if
  any capability is left. The harness still runs the image as uid 10870 directly.
