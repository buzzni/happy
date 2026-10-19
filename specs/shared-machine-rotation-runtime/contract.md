---
feature: shared-machine-rotation-runtime
status: pr-preparation-live-rollout-pending
last-updated: 2026-10-19
---
# Machine-v2 CLI runtime integration

Approved local scope: CLI source/tests, docs/cli-architecture.md and this runtime contract.
Core owns credential custody, authentication and authoritative session lifecycle. No external
API/schema changes are introduced here. Do not edit wire/server, deploy, restart shared
machines, install all dependencies, commit or push. Existing uncommitted API execution-proof
callback, canonical wire snapshot and server changes belong to the parent and are preserved.

Canonical DTO/signature contract: ../shared-machine-rotation-wire/contract.md (copied snapshot;
authoritative source is the shared-rotation-execution-20261019 checkout). Studio actual
claudeSetupTokenMachine{Routes,Store,Authority,Signer}.ts in shared-rotation-usage-20261019
was read for response shapes and operation semantics.

Plan / progress:
- [x] Read root contract/spec, local AGENTS and CLI architecture; preserve account-wide refusal classification/disposed suppression.
- [x] Failure-first machine receipt/record consumer test reproduces v2 parser rejection.
- [x] Pinned device protocol and secret-free durable operation recovery; exact encrypted-create proof and original session ownership.
- [x] Actual run.ts spawn/resume, channel host, webhook ACK, control usage/rebind and launcher continuation integration.
- [x] Failure/crash/concurrency/fairness/stop/legacy boundary tests; related tests and CLI typecheck evidence.
- [x] Refresh local CLI build and prepared-artifact guard after the final provider-start/resume changes.
- [x] Architecture/context synchronization.
- [x] Parent code review and focused regression corrections.
- [ ] Live cross-repository acceptance. No live acceptance claim.

New issuance is OFF unless HAPPY_SETUP_TOKEN_MACHINE_V2_ENABLED=true and a local exact
[companyId,machineId] pair is in HAPPY_SETUP_TOKEN_MACHINE_V2_ALLOWLIST. The configured
HAPPY_SETUP_TOKEN_MACHINE_V2_COMPANY_ID must match the current machine custody scope;
HAPPY_APLUS_STUDIO_ORIGIN, HAPPY_SETUP_TOKEN_MACHINE_V2_STUDIO_PUBLIC_KEY (raw base64url
Ed25519), and HAPPY_SERVER_URL pin both origins and Studio trust. These names configure
the daemon locally; Studio separately requires APLUS_SETUP_TOKEN_MACHINE_V2_ENABLED=true
and APLUS_SETUP_TOKEN_MACHINE_V2_ALLOWLIST with the same pair. Config/key/network failure
on an enabled shared path is a denial, never legacy fallback. Existing machine-v2 recovery
retains its pins even when new issuance is OFF. OAuth/Codex/personal and user-v1 remain separate.

Operation journals under HAPPY_HOME/machine-rotation contain only validated request bodies,
binding bodies, digests, action IDs and execution IDs. No signed ticket/grant, token or bearer
is written there. The existing session store retains its normal encryption information and
staged Happy identity; neither journal changes that credential custody boundary. Pending
intent is fsynced before selection/claim; binding session persistence ACK precedes Studio
commit; resume/query retries use the original operation IDs. Rename/directory-sync uncertainty
requires read+sync recovery; it never authorizes token return or a fresh selection.

## Integrated consumer behavior

`run.ts` stages and retains the original Happy owner, obtains the exact encrypted create
body through the parent API proof callback, precreates an execution-bound session before
provider spawn, and supplies the existing reconnect encryption envelope. Channel-host
sessions supply their trusted data key to this same path. Children and automation receive
fresh launch operations; public RPC selections cannot introduce machine authority. Exact
webhook session identity is checked. Legacy unbound sessions are never auto-promoted.

The API callback additively receives its already-selected encryption key/variant as a
second argument so preparation can be durably recorded before Studio issuance. The
parent's frozen-body, returned-proof validation and fail-closed API behavior remain.
`api.test.ts` is parent-owned and was not edited by this runtime work.

Final account-wide refusal evidence, including empty utilization windows, is included in
the rebind transaction with its original timestamp, observation ID and running generation.
The daemon's latest committed binding catches up a stale child. The existing serialized
credential launch queue rechecks organization approval, journal assignment generation,
fingerprint, applied receipt and exact current slot before token return/process submission.
Five successful switches are allowed; failed attempts do not consume that limit. Retries
retain a fixed 30-minute deadline and 60-second cadence, with machine FIFO requests and
Studio-budget Retry-After/jitter. Stop/disposal aborts outstanding control requests and
suppresses late notifications, switches and continuation. A new user message replaces
automatic continuation. A refused Claude conversation resumes once; a successful turn
is not replayed. No cswap global autoRotation toggle is used.

Only one secret-free message event carries optional
`setupTokenRotation:{version:1,state}`. Optional metadata uses
`{version:1,principalType:'machine',bindingVersion:0|2}`: 0 only for a confirmed legacy
shared setup-token path, 2 for a verified execution. Absence proves neither capability.

## Recovery and provider-start fences

Prepared encryption snapshots remain inside the existing private session store under
`preparedMachineLaunches`; they are not listed as resumable sessions. The original staged
Happy credential home survives orphan cleanup, PID reuse and pre-webhook child failure.
Session binding publication and read+sync recovery return explicit durability status;
monotonic writes prevent stale webhook/cursor memory from rolling back a newer revision.

An uncertain initial create is discovered through the original owner's paginated sessions
and the machine-authenticated execution-owner relation. A still-fresh create can replay
its exact encrypted body and deterministic original proof. An expired uncertain create
with no recoverable execution remains blocked with `PERSISTENCE_INDETERMINATE`, retaining
custody and intent. It never selects a replacement account to hide uncertainty. Recovery
queries the original issue/rebind operation; currentOperationId binds reconnect to the
latest committed revision. With new issuance OFF, recovery cannot create a previously
unreceived initial issue (`ISSUANCE_DISABLED`). Existing v2 authority must still validate.

Before actual process submission the journal durably records `startSubmitted:true` under
the credential launch queue. A missing Claude conversation ID permits a first start only
for exact committed revision 1, no pending operation, no submitted start, authenticated
original session identity and zero processed cursor. Fresh server sequence may contain
queued user messages. An uncertain/submitted start remains fail-closed. Active initial
preparation and the pre-webhook startup window block concurrent resume. Rebind preserves
the provider-start flag.

## Verification checkpoint

Failure-first checks reproduced v2 parser rejection, missing durability ACK, response-loss
and finished-session recovery failures, and missing-Claude-ID first-start rejection before
the corresponding fixes. The combined selected CLI suite passed **410 tests in 17 files**:
API create, record/parser and launch wiring, credential launch queue, durable persistence,
protocol/journal/runtime/recovery, control IPC, v1 switching, usage/controller, launcher,
channel host and resume planner/guards. Tests exercise actual consumer interfaces with
controlled network/provider effects; run.ts closure wiring also has explicit source guards.

CLI typecheck passed with the task-local `/tmp/claude/happy-t2-3t0ou8jl/runtime-tsconfig.json`
(preserving `@/*`, mapping wire to this checkout's built declarations). Vitest uses the
sibling `review.config.mjs` to resolve this checkout's CLI/wire source while disabling
unrelated build global setup. Dependencies remain symlinked; no install-all was performed.
The final run.ts preservation catch was verified by 67 passing tests in four selected
files (runtime, launch wiring, resume planner and resume guards), and CLI typecheck passed
again. These 67 overlap the combined 410; they are not additional distinct tests.

The final source was rebuilt with pkgroll and the task-local `build-tsconfig.json`,
then browser-extension files were copied and a fresh package was prepared at
`/tmp/claude/happy-machine-rotation-artifact-20261019`. The structural guard passed for
`1.1.10-aplus.341`, checking 13 required bundled files with local wire 0.1.0. Pkgroll exited
0 with warnings about bin files outside dist and empty chunks. The guard uses isolated
`/tmp/claude/happy-machine-rotation-npm-cache`; shared cache permissions were not changed.

The prepared artifact's `--version` and `daemon preflight` both exited 0 under a fresh
isolated HAPPY_HOME_DIR and unreachable loopback server URL. Missing external dependencies
were temporarily linked to already-installed dependencies, then those links were removed.
This checks bundled CLI imports/control-route initialization; it is not an installed-artifact
smoke or production dependency-closure check. No daemon start/restart was performed.

Reproducible final checks (from the exclusive checkout; test/build paths use the existing
CLI dependency tree):

```sh
node /Users/justin/workspace/happy/packages/happy-cli/node_modules/typescript/bin/tsc --project /tmp/claude/happy-t2-3t0ou8jl/runtime-tsconfig.json --noEmit
# PASS
# From packages/happy-cli, combined suite before the final preservation catch:
node /Users/justin/workspace/happy/packages/happy-cli/node_modules/vitest/vitest.mjs run \
  --config /tmp/claude/happy-t2-3t0ou8jl/review.config.mjs \
  src/api/api.test.ts src/daemon/sessionEnv.test.ts src/daemon/aiAuthSelectionWiring.test.ts \
  src/daemon/aiCredentialSetupToken.test.ts src/persistence.durableSession.test.ts \
  src/daemon/machineSetupTokenRuntime.test.ts src/daemon/machineSetupTokenProtocol.test.ts \
  src/daemon/machineSetupTokenJournal.test.ts src/daemon/machineSetupTokenRecovery.test.ts \
  src/daemon/controlServerSetupToken.test.ts src/daemon/setupTokenAccountSwitch.test.ts \
  src/claude/setupTokenUsageTracker.test.ts src/claude/setupTokenAccountSwitching.test.ts \
  src/claude/claudeRemoteLauncher.setupTokenSwitch.test.ts src/channelHost/channelHostSessions.test.ts \
  src/resume/handleResumeCommand.test.ts src/daemon/resumeGuards.test.ts
# PASS: 410 tests, 17 files
# Final directly affected checks after the preservation catch:
node /Users/justin/workspace/happy/packages/happy-cli/node_modules/vitest/vitest.mjs run --config /tmp/claude/happy-t2-3t0ou8jl/review.config.mjs src/daemon/aiAuthSelectionWiring.test.ts src/resume/handleResumeCommand.test.ts src/daemon/resumeGuards.test.ts src/daemon/machineSetupTokenRuntime.test.ts
# PASS: 67 tests, 4 files
node /Users/justin/workspace/happy/packages/happy-cli/node_modules/pkgroll/dist/cli.mjs --tsconfig /tmp/claude/happy-t2-3t0ou8jl/build-tsconfig.json
node scripts/copy-browser-extension.cjs
# PASS
# From repository root:
node packages/happy-cli/scripts/prepare-publish-package.cjs --out /tmp/claude/happy-machine-rotation-artifact-20261019
npm_config_cache=/tmp/claude/happy-machine-rotation-npm-cache node packages/happy-cli/scripts/guard-publish-artifact.cjs /tmp/claude/happy-machine-rotation-artifact-20261019
git diff --check
# PASS
```

No package lint script/configuration is defined. The default package build/test commands
were not used because the shared dependency tree requires the temporary source/declaration
mappings and the default test workflow invokes unrelated build/global setup. Selected
checks above are the evidence; no full-suite or official-install result is claimed.

Real provider/account, integrated Studio+Happy acceptance, production migration, Windows
filesystem durability and shared-machine restart/rollback acceptance remain unperformed.
Parent review is pending. No commits, version bump, push, deployment or live DB mutation.


## Parent integration verification (2026-10-19)

Four lasting regressions cover exhausted-operation recovery, observation identity,
current-operation resume and proactive-warning retry timing. The first and fourth
failed against the final child implementation; recovery now clears pending intent
and raises NO_ACCOUNT without returning the old token, and only a refused turn starts
the fixed retry deadline. Child observation hashing and currentOperationId are retained.
The corrected runtime/controller/launcher suites pass 64 tests. CLI typecheck and
pkgroll rebuild pass. A fresh final-source package at `/tmp/claude/happy-machine-rotation-final-20261019`
passes the structural guard (13 bundled files, unchanged 1.1.10-aplus.341).
The isolated version/preflight evidence above predates these two fixes; the final
artifact has not undergone installed-artifact or live acceptance.

Server unique-key HTTP verification is integrated. Server/wire source identity was
checked against the server review checkout, where all 39 selected server tests and
typecheck pass. The integrated checkout lacks the server Vitest executable, so no
server test success is claimed there. Parent review is complete for local changes;
installed-artifact, live integrated and production acceptance remain pending.

## Local cross-repository acceptance — 2026-10-19

This section supersedes older statements that no producer-output or browser check was run.
No product code was changed in this verification pass. Added an opt-in cross-repository
HTTP test and a Happy consumer test; synthetic keys/accounts only, no production calls.

- Actual Studio HTTP routes, signer, authority and PGlite migration/store drove the actual
  Happy CLI protocol/runtime/journal: issue → usage → rebind → lost commit response →
  reconstructed runtime/resume → second-account exhaustion. No token environment was
  returned before database commit, and exhaustion never returned the previous token.
- The actual producer proof was exported by that test and consumed unchanged by Happy's
  real session-create HTTP route and Prisma/PGlite store. Exact retry created one session
  and one notification; execution-owner lookup succeeded while ordinary ownership stayed
  isolated. Ciphertext tampering and machine-owner substitution returned 403.
- Studio/Web related suite: 44 passed, 1 opt-in test skipped in the default run. Cross-repo
  config: 1 passed, 36 unrelated tests filtered out. Happy session boundary: 22 passed,
  including the producer-output case. Studio changed-file ESLint passed; type ratchet
  matched all 492 existing diagnostics. Happy server typecheck passed in the server review
  checkout; the identical consumer test was copied into the integrated checkout.
- Local Chrome harness imported the actual ChatMachineStatus, event parser, Korean catalog
  and CSS. Unknown/legacy/v2 compatibility and switching/switched/exhausted/retrying text
  were checked. Final legacy/v2 screenshots were captured. This is component/browser
  acceptance, not the full ChatPanel, a WebSocket feed, or a real daemon/provider run.
- Remaining: installed CLI artifact, real shared-machine spawn/provider execution, real
  PostgreSQL concurrency, Windows durability and production deployment/acceptance.

Reproduction from Studio packages/web-ui (use the integrated Happy checkout as `$HAPPY_ROTATION_CHECKOUT`):

```sh
ROTATION_PRODUCER_FIXTURE=/tmp/rotation-producer-output.json HAPPY_ROTATION_CHECKOUT="$HAPPY_ROTATION_CHECKOUT" ./node_modules/.bin/vitest run --config vitest.rotation-integration.config.ts -t cross-repository
./node_modules/.bin/vitest run server/claudeSetupTokenMachineRoutes.test.ts src/lib/sync/setupTokenRotation.test.ts
./node_modules/.bin/eslint server/claudeSetupTokenMachineRoutes.test.ts vitest.rotation-integration.config.ts
npm run typecheck:ratchet
```

Then from a Happy checkout with server dependencies installed:

```sh
ROTATION_PRODUCER_FIXTURE=/tmp/rotation-producer-output.json corepack pnpm -C packages/happy-server exec vitest run sources/app/session/sessionExecutionBinding.spec.ts
corepack pnpm -C packages/happy-server run typecheck
```

The artifact contains only synthetic test claims/public key. Both opt-in tests skip when
these environment inputs are absent; they must be explicitly enabled for cross-repo acceptance.


## Live failure diagnosis and rollout boundary — 2026-10-19

This checkpoint supersedes the earlier local-only commit restrictions and historical
statements about uncommitted changes. The requested production failure was inspected
through the authenticated Web UI without changing assignments or restarting a daemon.

The affected shared machine has a connected Claude setup-token assignment, but its
read-only daemon diagnosis reports **1.1.10-aplus.330**. The UI advertises .344 as latest;
origin/main at 24b6c3e69 does not contain machine-v2 rotation. The chat returned the
provider's weekly-limit response without rotation. Credential delivery succeeded; that
status does not establish execution binding or rotation capability. Updating to .344
alone cannot provide this still-unreleased implementation.

The rotation branch was rebased onto that main, excluding three unrelated observation
commits from its inherited base. A local backup branch preserves the original history.
No automatic promotion of legacy sessions is added: after rollout, an existing unbound
chat still cannot acquire machine authority by resume. Validate a fresh execution bound
under v2; preserve the original conversation and journal evidence.

Rollout order (not executed by this checkpoint):
1. Merge reviewed Happy server/wire/CLI changes; update Studio vendor/happy to the
   reviewed Happy commit so the server image actually includes execution-proof support.
2. Deploy the additive Happy and Studio migrations and server code with issuance OFF.
   Pin the same trusted Studio public key and origins at both servers/daemon.
3. Publish a new CLI version through the GitHub Actions tag workflow and install it
   on the target machine; the local branch's old package version is not a release.
4. Verify device approval and re-apply the current assignment to refresh receipt
   metadata. Enable only the intended company/machine pair on Studio and daemon.
5. Verify a fresh bound execution with two usable accounts, final account-wide refusal,
   successful account switch/continuation, stop handling and exhaustion. Never call
   a code merge or component test live acceptance.

Main merge, release tag/publication, operational migrations, rollout flags and shared
machine restart remain pending. Keep issuance OFF on rollback, retain v2 evidence/readers,
and do not fall back to a legacy credential when configured v2 validation fails.

Final post-rebase checks for this checkpoint: CLI rotation/resume suites **109 tests**
passed in six files; actual Happy execution create/owner HTTP boundary **23 tests**
passed in two files using the current integrated checkout and the Studio-produced proof.
CLI typecheck passed after rebuilding this checkout's wire declarations for the new main.
The dependency tree was reused via a local server node_modules symlink; it is not staged.
Studio→CLI HTTP integration also passed against this rebased source. These are local
synthetic-account tests, not a live provider/daemon result.
