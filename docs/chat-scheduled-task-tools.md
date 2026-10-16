# Current-Chat AI repeating task tools

`scheduled_tasks` manages `list`, `get`, `create` and `set_paused` for the caller's current ordinary Chat. It is distinct from `script_automations`. Stop means pause future runs; it preserves history and an active turn. No edit, delete, run-now or other-Chat operation is exposed. Daily times follow the execution PC; intervals require at least 15 minutes. Payloads inherit the conversation's AI/model and contain no model override.

The CLI forwards its actual session/machine/path to Studio's `/api/automation/scheduled-management`. Studio verifies signed Chat caller authority, machine credentials, current ownership/ordinary session mapping and execution policy. The tool cannot select a different account, Chat, machine or model. Public input and internal transport schemas live in `happy-wire/src/scheduledTasks.ts`.

Creation uses a stable 16–128 character registration key. Happy's scoped registration GET/PUT returns one authoritative paused v4 definition; Studio records the optional/empty-connector execution binding before activation. A missing receipt or failed binding is recovered with the same key/ciphertext through `complete_registration`. Never replace an uncertain request with a fresh key. The CLI decrypts the returned row and compares the entire intended payload. A later explicit pause/edit is never implicitly resumed by retrying create. Pause/resume uses the existing revision CAS. Receipts distinguish the current revision's runner application (`runnerApplied`, `appliedRevision`) from execution (`executionConfirmed: false`); they do not prove a completed AI response.

Initial support requires legacy local account credentials whose derived content key matches the existing viewer key, plus a machine advertising server-backed ordinary conversation delivery. The tool is absent from protected MCP sessions and rejects strict machine control, required authenticated envelopes, dataKey-only credentials and mismatched viewer keys. It does not inject private keys, overwrite viewer keys or fall back to unauthenticated customer sealing. Compatible Studio, Happy server and CLI changes must be rolled out together; disabling Studio `HAPPY_SCHEDULED_TASK_TOOLS_ENABLED=0` restores existing UI-only management without deleting definitions/history. Official CLI release and deployment remain separate approval steps.

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

Local verification on 2026-10-16: 41 server tests, 41 CLI/MCP tests, 32 existing wire tests, CLI/server/wire type checks, CLI build and one real PostgreSQL/server/daemon scenario passed. Studio's 193 related tests/targeted lint/type ratchet and Desktop's CLI ciphertext/read-update tests/native fixture were verified in their owning repositories. This does not establish an official release or production browser acceptance.
