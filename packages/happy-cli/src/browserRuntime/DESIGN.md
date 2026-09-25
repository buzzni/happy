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
- Attention outbox (`attention.ts`): transitions are tagged `data.attention` at commit time
  (approval decided, takeover released, user resume, recovery); the outbox observes TaskStore
  commits and `reconcile()` repairs a crash between the task commit and the outbox write.
- User resume (D8): interactive `resume` only from `user-input-complete`, and only while the
  task's stored grant is valid; approval waits, uncertain writes, cancel requests and
  browser replacement are never released by the user.
- Writer lock (D9): the image entrypoint runs `exec flock -n -E 75 -F <state>/runtime.flock node`;
  production refuses to start unless `/proc/locks` shows this pid holding it. The heartbeat
  lease and fencing token stay. The container runs as uid 10870 (no host login user).

## Runtime viewer (S4, 2026-09-25)

Saydo `specs/agent-browser-deploy/` D2. Files: `viewerProxy.ts`, `rfb.ts`, `server.ts` routes.

- `POST /v1/ops/viewerTicket` (interactive operation) → one-time ticket, 30 s or the capability's expiry,
  bound to the capability and profile. `GET /v1/viewer/websockify?ticket=` spends the ticket even when
  refused; `Origin` must be a configured tunnel origin (`viewerOrigins`) or `http://<Host>` for a
  loopback Host literal (a DNS-rebound name never matches).
- Two independent RFB sessions per connection: RFB 3.8 server to the viewer (security None — the ticket
  authenticated it; desktop name replaced), RFB client of x11vnc (VNC authentication with the per-run
  password, shared). x11vnc listens on the profile network (no `-localhost`), is never published.
- Viewer→upstream: every message is parsed (`rfb.ts` generator parsers + `StreamFramer`). SetPixelFormat,
  SetEncodings (≤ 64, filtered to Raw/CopyRect/Hextile/ZRLE/DesktopSize/Cursor) and
  FramebufferUpdateRequest pass. Key/Pointer/ClientCutText (≤ 64 KiB) pass only while every user-owned
  tab of the profile belongs to this capability's viewer, no takeover is settling, and the bound
  `tab@epoch` set is unchanged. Any change (release, new epoch, other owner) drops queued input and sends
  key-up for held keys and a button release first; `InputLeaseManager.subscribe` makes this immediate.
  Capability expiry closes (4001) after the same release; revocation is polled every second and on input.
- Upstream→viewer: framed, not byte-passthrough. The server stream's lengths follow from headers only
  for the filtered encodings, so the proxy validates every header (message type, rectangle inside the
  framebuffer, encoding actually requested, ZRLE/cut-text length bounds) before forwarding and streams
  the payload. A malformed or unexpected server message closes the connection (1011) instead of reaching
  the viewer's decoder. Cost: Tight is not offered, so noVNC 1.3 uses Hextile (more bandwidth).
- `/viewer/` serves the pinned noVNC client (Runtime image copies Debian bookworm `novnc=1:1.3.0-1`,
  no CDN; `vnc_lite.html?path=v1/viewer/websockify%3Fticket%3D…`).
- Harness: `poc.mjs up --viewer runtime` (pocStack `viewer: 'runtime'`) is the production layout — no
  websockify, nothing published but the Runtime. The default harness layout still starts and publishes
  noVNC (`ABP_HARNESS_NOVNC=1`) because A11 probes it directly; A04/A09 inject human input with xdotool
  on the display and do not depend on either viewer. The browser image starts websockify only when
  `ABP_HARNESS_NOVNC=1`.
