# Current-Chat AI repeating task tools

`scheduled_tasks` manages `list`, `get`, `create` and `set_paused` for the caller's current Work Chat or owned Project conversation. It is distinct from `script_automations`. Stop means pause future runs; it preserves history and an active turn. No edit, delete, run-now or other-Chat operation is exposed. Daily times follow the execution PC; intervals require at least 15 minutes. Payloads inherit the conversation's AI/model and contain no model override.

The CLI forwards its actual session/machine/path to Studio's `/api/automation/scheduled-management`. Studio verifies signed Chat/Project caller authority, machine credentials matched to the Chat's authoritative Happy account (not only a reusable machine ID), current ownership and live session/worktree mapping and execution policy. The tool cannot select a different account, Chat, machine or model. Public input and internal transport schemas live in `happy-wire/src/scheduledTasks.ts`.

Creation uses a stable 16–128 character registration key. Happy's scoped registration GET/PUT returns one authoritative paused v4 definition; Studio records the optional/empty-connector execution binding before activation. A missing receipt or failed binding is recovered with the same key/ciphertext through `complete_registration`. Never replace an uncertain request with a fresh key. The CLI decrypts the returned row and compares the entire intended payload. A later explicit pause/edit is never implicitly resumed by retrying create. Pause/resume uses the existing revision CAS. Receipts distinguish the current revision's runner application (`runnerApplied`, `appliedRevision`) from execution (`executionConfirmed: false`); they do not prove a completed AI response.

Support includes legacy viewer credentials and compat dataKey credentials with only the existing account public key and registered local machine automation key. dataKey metadata is read with its existing machine key; no account private key or legacy backup is restored. Creation verifies the registered machine key before management writes, preserves the exact viewer key (CAS only for first registration), and seals the same v4 payload for viewer and machine. Reads use a separate authenticated `scheduledManagementAutomationSchema` with the machine envelope; public `AutomationPublic` and UI responses remain unchanged. A readonly `read_target` never bootstraps a target. Strict machine control and required authenticated sealing remain unsupported; machine self-signing is not introduced.

Project transport adds the expected `projectId` and actual session directory internally, never to model-controlled tool arguments. Studio verifies the signed scope, owned/live ProjectSessionMap, machine/account and worktree directory. Its additive nullable conversation binding fields do not affect existing UI definitions. It reserves the deterministic binding before paused creation, filters every management response by that binding, and rechecks access/mapping before grants and each dispatch. Different sessions cannot recover each other's registration keys. Compatible Studio, Happy server and CLI changes must roll out together. Disabling Studio `HAPPY_SCHEDULED_TASK_TOOLS_ENABLED=0` blocks management but does not stop existing tasks; pause individual test reservations and preserve definitions/history when rolling back.

Runtime prerequisites use `SCHEDULED_TASK_` / `SCRIPT_` plus `CONFIG_REQUIRED`, `MACHINE_CONTEXT_REQUIRED`, `CREDENTIALS_REQUIRED`, or `CALLER_GRANT_REQUIRED`. Scheduled dataKey additionally requires an existing registered automation key (`MACHINE_KEY_REQUIRED`/`MACHINE_KEY_MISMATCH`); the script tool retains its separate `CREDENTIALS_UNSUPPORTED` contract. Missing grants must come from the app's authorized launch/resume: refresh cannot mint a missing grant.

## Focused verification

From `packages/happy-server`:

```sh
corepack pnpm exec vitest run sources/app/automation/automationService.spec.ts sources/app/api/routes/automationRoutes.spec.ts
corepack pnpm exec tsc --noEmit
```

From `packages/happy-cli`:

```sh
corepack pnpm exec vitest run --project unit src/claude/utils/scheduledTaskTools.test.ts src/claude/utils/startHappyServer.test.ts
corepack pnpm exec tsc --noEmit
HAPPY_SCHEDULED_TOOLS_INTEGRATION=1 HAPPY_SCHEDULED_TOOLS_DATABASE_URL='<disposable local PostgreSQL URL>' corepack pnpm exec vitest run --project integration-scheduled-tools
```

The integration fixture owns isolated HOME/account/server/daemon processes and a loopback model endpoint. Supply a disposable local DB only: it applies existing migrations, never resets a user DB. Studio authority/bindings are a local contract fixture; Studio separately tests its actual HTTP route/service. The integration races real registration HTTP writes, forces three due deliveries using the existing run-now API (rather than waiting 15 minutes), inserts a follow-up, checks encrypted same-session/provider identity, and pauses/resumes with unchanged ciphertext. It performs no external AI call or PC update. PGlite's existing Prisma bytea read failure prevents this scenario on the current dependency combination; PostgreSQL was used without modifying that adapter.

Local verification on 2026-10-16: 41 server tests, 42 CLI/MCP tests, 32 existing wire tests, CLI/server/wire type checks, CLI build and one real PostgreSQL/server/daemon scenario passed. Studio's 195 related tests/targeted lint/type ratchet and Desktop's CLI ciphertext/read-update tests/native fixture were verified in their owning repositories. This does not establish an official release or production browser acceptance.

Clean-code review (2026-10-16): same-ID/different-account machine credentials are refused; pause/resume and activation receipts must retain ID, ciphertext, key and ownership fields and advance revision/generation to the requested state. Malformed upstream responses return a server response error, not an input validation error. The initial viewer-key retry regression passed alongside the existing CLI/MCP cases.

The runtime requires the current session's machine ID already provided by its MCP caller; it does not infer a different machine from global local settings.

## Scheduled occurrences

An encrypted message marked `sentFrom: automation` with a `happy-automation:` local key is an occurrence of an existing task. The shared session input boundary adds model-only instructions to execute its underlying work once, leave recurrence to the scheduler, and avoid creating/resuming another reservation or substituting `script_automations`/cron. Stored message ciphertext and visible user text stay unchanged. Manual follow-ups keep their original input; legacy initial turns receive the same guidance alongside their existing diagnostic preamble. GitHub/AgentTask-specific prompts retain their own contracts. This is execution guidance, not a replacement for server authorization or a sandbox capability boundary.

2026-10-16 release preparation: API buffering/immediate delivery and legacy Claude/Codex regression cases failed on the old source, then API/MCP/executor suites passed 314 cases. Candidate `1.1.10-aplus.334` is prepared for the official tag workflow; production publication/deployment/PC verification require separate recorded results.

Release candidate verification: 245 wire tests, 41 Happy server tests, 314 focused CLI/MCP/session/executor tests and CLI/server type checks passed. The isolated PostgreSQL/server/built-daemon scenario passed with three occurrences, unchanged stored task text, model-only occurrence guidance, one reservation and same-session follow-up/pause/resume. These are local protocol checks; official publication and live PC/provider/timer acceptance remain pending.

## dataKey / Project recovery candidate — 2026-10-16

Candidate `1.1.10-aplus.336` adds the internal management machine-envelope response, readonly registered-machine public-key lookup, dataKey reader/writer and Project session transport. Focused CLI/MCP/executor/environment suites pass 207 cases, server API/service suites pass 52, and wire/CLI/server types plus the built CLI and prepared-package install smoke pass. Studio separately verifies its binding/mapping/HTTP paths and additive migration.

The extended isolated daemon test now covers both legacy Work Chat and dataKey Project, including real registration races, three deliveries, encrypted follow-up and pause/resume. This session's nested macOS sandbox rejects sandbox-exec before the fixture's initial AI reply; that run is not an integration success. The existing macOS CI job runs the same fixture against an isolated PostgreSQL database on its ordinary host sandbox. Do not report runtime recovery until that check and the subsequent official rollout/live timer acceptance have passed. No current-user credential, shared daemon or installed CLI was changed by preparing this candidate.
