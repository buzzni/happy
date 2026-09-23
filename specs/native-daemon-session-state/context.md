# Completed implementation

Isolated clone `/tmp/saycode-native-probe-happy`, branch `native-daemon-probe`, base `420f127365507eddee53b459e6413ba3ee45f754`.

`daemon-session-state` accepts one session ID and returns only version 1 plus present/missing/unknown. The handler reads `getCurrentChildren()`, the same `pidToTrackedSession` snapshot passed to local `/list`. It matches `happySessionId`, never pending `resumeTargetSessionId` or the archived `sessionIdToFinishedSession` map. It does not spawn a shell, read session transcripts, return PIDs, mutate processes, or perform I/O. Invalid requests and failed snapshot reads return unknown; read failures leave a fixed diagnostic without request values or raw exceptions.

The capability is published by ApiMachineClient's existing encrypted metadata keepalive only with a registered reader and no managed runtime handlers. Missing readers and managed runtimes clear stale advertisements. The common `initialMachineMetadata` remains unchanged because Claude/Codex/ACP/Gemini/OpenClaw session processes also use it. Existing machines get capability updates on the first connection, not only on machine creation.

## Startup ordering and interpretation

In `run.ts`, previous daemon state is awaited and tracked children hydrated around lines 1057–1110. Startup orphan adoption completes around lines 1258–1283. The RPC handler is registered around line 4120 and the machine socket connects around line 4183. No native request can observe the initial empty map while that startup recovery is still executing.

Presence is exactly current daemon tracking, as `/list` was; it is not a complete operating-system process census or proof that the tracked PID is still alive. Existing recovery failure handling and later child registration remain unchanged. Archived records alone never establish presence.

## Authentication and managed restrictions

- Happy server's machine socket authentication checks accountId plus machineId ownership (`machineSocketAuth.ts`, called by `socket.ts`).
- Legacy RPC registration/calls are scoped to authenticated userId rooms (`rpcHandler.ts`); request/response encryption is handled by the existing machine-key `RpcHandlerManager`.
- Legacy RPC registration does not independently enforce a session ACL or enforce method scope on every rpc-register. This is an existing account/key boundary, not a new per-session authorization guarantee. A caller already authorized for this machine can use the existing bash/list RPC; this new endpoint returns less information, for a single supplied ID. Do not grant machine RPC credentials solely because a caller can see a shared session.
- No server authorization, RPC registration policy or managed allowlist was expanded. Managed daemons still reject this method with `MANAGED_CAPABILITY_REQUIRED`; they do not advertise the capability.

## Verification

- API registration test failed before implementation; three capability publication/removal tests failed before keepalive wiring.
- 260 tests passed across `daemonSessionState.test.ts`, `apiMachine.test.ts`, `managedRpcHandlers.test.ts`, `rpcRequestListener.test.ts`, and `aiAuthSelectionWiring.test.ts`.
- New cases cover requested-ID presence/missing, current snapshot after removal, pending resume exclusion, malformed requests, snapshot failure logging/unknown, encrypted dispatch, managed rejection, capability schema version, and capability publish/remove behavior.
- Tests ran with an external temporary Vitest config using the repository alias and unit setup, omitting only the global setup's repeated full build.
- `tsc --noEmit` passed. `pnpm run build` for happy-wire and happy-cli passed. CLI pkgroll emitted bin-outside-dist and empty-chunk warnings; no TypeScript errors remain.
- The first typecheck used an older external happy-wire artifact and failed on unrelated aiAuth exports. Built this clone's happy-wire and pointed only the clone's dependency at it; the unchanged source then typechecked successfully. No shared dependency artifact was rebuilt.
- `git diff --check` passed.

No CLI version bump, commit, push, release, publish, install, active daemon restart, or runtime policy change was performed. Source changes still require the authorized release/deployment workflow before an installed daemon can advertise this capability.

## Release candidate 2026-09-22

Rebased onto main 84df0800 (.227). Resolved apiMachine field conflict by preserving main removal of isolatedViewerLeases and adding only daemonSessionStateRpcAvailable. Candidate .228: 260 targeted tests, tsc --noEmit, and CLI build passed; existing pkgroll warnings remain. Tag/registry/runtime verification pending.
