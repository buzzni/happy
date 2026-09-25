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
  hidden in a headful browser and cannot be captured), capped per profile (see "Agent windows").
- Refs resolve only against snapshots the agent received; dispatch-time checks use
  `describeRef` (no new snapshot). Approvals persist a structural element identity so a
  pending approval survives a Runtime-only restart when document and node are unchanged.
- Writer lock = heartbeat lease (5 s refresh, stale after 20 s) + fencing token;
  `runtimeMain` waits for a dead writer's lease to expire before giving up.
- Acceptance results, gates and the No-go verdict: Saydo `specs/agent-browser-poc/results.md`.

## Deployment readiness (Saydo `specs/agent-browser-deploy/`, S5: D5–D7)

### Agent windows (D5)

Spike 2026-09-25 against the pinned headful Chromium 153.0.8010.52 (`abp-browser:pocfix`,
Xvfb, no window manager), reproducible with `scripts/browser-poc/spikes/window-placement/`.

| Question (anchor pool: driver-owned anchor tab per window, task tab via `window.open('about:blank','_blank','noopener')`) | Result |
|---|---|
| Lands in the anchor's window as its active tab | yes (every run); `window.open` returns null, target has `openerId` but `canAccessOpener: false` |
| Attach via `Target.targetCreated` + `attachToTarget` | yes |
| Paints for `Page.captureScreenshot` while other windows exist | yes (two task tabs in two anchor windows, exact colours) |
| Closing the task tab keeps the window/anchor; `beforeunload` still blocks `Page.close` | yes / yes |
| Anchor closed while a task tab is in its window | task tab survives, window stays (becomes unpooled) |
| **Does not take focus from the user's window** | **no: X input focus moved to the anchor window 3/3, a typed key reached the task tab 3/3.** `createTarget(newWindow, background)` kept focus 3/3 |

Memory (sum over Chromium processes in the container):

| | per window RSS / PSS | browser_ui targets per window | 400-window churn PSS (first 50 → 400) |
|---|---|---|---|
| default | +147 / +40 MiB | 2 (`chrome://omnibox-popup.top-chrome/…`) | 349 → 487 → 472 MiB |
| `--disable-features=WebUIOmniboxPopup,WebUIOmniboxAimPopup,WebUIOmniboxFullPopup` | +130 / +23 MiB | 0 | 340 → 387 → 422 MiB |

Decision: the anchor pool is **not** used (focus theft would send the viewer's keystrokes into an
agent tab). Instead: one background window per owned tab as before, at most `maxAgentWindows`
(default 4, `ABP_MAX_AGENT_WINDOWS`, ≤ tab quota) per profile, and the omnibox WebUI features off
in the browser image. Accounting (review P1-8): one reservation per target — taken before
`createTarget`, moved to the live target in the same tick, released only on `targetDestroyed`
(a failed cleanup keeps it); popups of owned tabs count too, and a popup over the cap is closed
with every request of it failed. Whether this meets the 30-minute soak criterion is measured by
`soak.mjs`, which reports cgroup memory and the Chromium process RSS sum separately.

### Destinations before requests (review P0-3)

The driver auto-attaches every new page at browser level, paused (`waitForDebuggerOnStart`).
Owned tabs, their OOPIFs and workers, and their popups (recursively, including `noopener`) get
`Fetch.enable` before they run; other pages are released at once. Document, XHR, Fetch, Ping,
EventSource, CSP-report and Other requests whose destination is not an allowed origin of the tab
are failed unsent (redirect hops included); subresources (script, style, image, font, media) are
not checked. A popup whose document is stopped is closed. `blockedReports()` keeps origins only.
Not covered: WebSocket/WebTransport/WebRTC, service-worker-initiated fetches, subresource GETs.
A paused target answers only Fetch/auto-attach until resumed, and a same-site popup shares its
opener's renderer (it must be resumed — with its requests failed — never left paused).

### Approval binding (D6)

- `describeRef` returns the complete form submission (`FormSubmission`): absolute action,
  method, enctype, effective target (own, else `<base target>`), every entry in submission order
  (duplicates kept), the submitter with `formaction/formmethod/formenctype` overrides. Built by
  hand (no `formdata` event) through `HTMLFormElement.prototype` getters. `formDigest` = SHA-256 of
  its canonical JSON. A form whose content cannot be bound — a non-empty password, a chosen file,
  a form-associated custom element — is `opaque`: its submit/form click is handed to the user
  (`awaiting-user`, `waitReason: 'handoff'`), never approved (review P0-5).
- The approval payload hash binds the digest, the live role/name, link URL and target. The
  persisted summary is value-free: method, destination without query, new-window flag, field
  names (review P0-6). The user sees the values in the viewer.
- Approve and dispatch re-describe the element; a different identity, digest, label or document
  expires the approval. The click carries the expectation into the driver (`DriverOptions.expect`),
  which re-checks it after the hover and arms a one-shot in-page guard: a capturing `submit`
  listener recomputes the submission and cancels a changed one; a `formdata` listener compares the
  final entries and destination. Verdicts reach the driver through an isolated-world binding
  (Runtime domain on only while armed); document requests of the tab wait for the verdict and are
  failed when blocked or when method/destination differ (review P0-4).
- Driver checks right before input: same-node relabel → `STALE_REF`; for elements in iframes
  every ancestor document must hit the iframe element at the click point. A transformed or
  zoomed iframe (or ancestor) is not guessed: handed to the user (review P0-7).
- Limits: purely visual relabels (CSS `content`, images, canvas); submit/formdata listeners the
  page adds after the guard (and JS that sends the data itself, e.g. `fetch` in a click handler,
  to an allowed origin); step payload hashes in the journal are unkeyed.

### Site policy (D7)

- `sites: [{ origin, actions: [{ match, risk }], loginCompleteWhen }]` (`policy.ts`,
  `ABP_SITE_POLICY` JSON, validated strictly; required at startup). Match conditions: `kinds`
  (navigate, link, submit, form-click, click, fill), `targetPaths`/`pagePaths` (exact or `prefix*`),
  `namePrefixes`, `roles` — no regular expressions. First matching rule wins.
- Origins without a policy cannot be opened; the agent grant's origins are narrowed to sited
  origins for every navigation/redirect/observation.
- Decisions: `auto`, `requires-approval`, `handoff`, `deny`. Refused outright: destinations that
  are not http(s) (`javascript:`, `data:`, `vbscript:`, `mailto:` …) or not sited, for navigation,
  links and forms. A link inside a form is a form click. Unmatched submit / form click / other
  click / fill → approval (fills via the approval flow, value never persisted); links outside forms
  and navigation → automatic. `openPage` applies the navigation rules (a held page is not opened,
  `APPROVAL_REQUIRED`); a navigate step held by policy is handed to the user (review P0-1/2).
  Held for approval regardless of rules: elements without a snapshot label, elements in frames of
  unsited origins.
- After a handoff the user takes over, acts, releases; `resume` returns the task to
  `awaiting-agent` without re-running the step.
- Login completion uses the site's `loginCompleteWhen` (URL prefix + optional text/element);
  login *detection* is still the fixture's `/login` path rule.
- Harness mode: `testing/fixtureSitePolicy.ts` reproduces the PoC classifier for the synthetic origins.
