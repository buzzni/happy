# Mandatory remote Claude sandbox (S1)

Scope: dedicated Linux machines with `/etc/aplus/sandbox-policy.json` set to
`{"mode":"mandatory"}` and an enabled session sandbox config. Owner-choice
sessions retain their existing behavior. No deployment or daemon mutation is
performed by these changes.

`claudeProcessSandbox.ts` prepares sandbox-runtime 0.0.37 before SDK query and
probes it with `/bin/true`. The synchronous SDK hook returns the actual bwrap
ChildProcess; checkpoint process tracking and provider exit observation remain
attached to that object. Preparation failures terminate the mandatory launch
with `MandatorySandboxError`, without the ordinary provider retry loop.

The package launcher `bin/claude-sandbox-launcher.sh` consumes a unique 0600
NUL-delimited argv file (`O_EXCL`, `O_NOFOLLOW`) in a host-only 0700 directory
under `/tmp`. It rejects changed modes, symlink files and non-private parents,
unlinks the file, and execs argv without shell evaluation. The package prefix
is read-only inside bwrap. Host tmp is hidden before runtime mount restrictions
are applied; only the working directory, private tmp and private Claude state
are writable. PID/net namespaces, fresh proc, dropped capabilities,
die-with-parent and the runtime's AF_UNIX seccomp filter are mandatory.

The outer launcher uses a fixed system PATH, not a session-provided helper path.
The child env is an allowlist; Happy/daemon/browser grants, NODE_OPTIONS,
BASH_ENV, arbitrary proxy variables and unrelated credentials do not pass.
Claude authentication variables are allowed. Nonessential traffic and automatic
updates are disabled. CLI SDK 0.3.276 and sandbox-runtime 0.0.37 are pinned in the
package manifest and lockfile; no application dependency was added.

An optional root-owned, non-group/world-writable, non-symlink file
`/etc/aplus/claude-sandbox.json` can contain:

```json
{"allowedDomains":["api.anthropic.com","claude.ai","platform.claude.com"]}
```

Those are also the defaults. Only exact DNS names are accepted. Empty domains
or a session's blocked network mode deny all proxy destinations. Session deny
rules may narrow the installation policy; session extra writable paths cannot
widen the process boundary.

## MCP and private provider state

Mandatory Claude sessions expose `change_title` and, when the browser Runtime
is configured, the 12 `browser_task_*` tools. `bash_stream`, script automations,
legacy browser tools and lesson proposals are not registered, including for
callers that guess their names. The session server listens only on its private
0600 Unix socket and authenticates every HTTP request with a random session
token. Ordinary sessions keep their HTTP transport and tool surface.

**Contract deviation:** sandbox-runtime's Linux seccomp blocks *all* AF_UNIX
socket creation; its `allowUnixSockets` is not a path exception on Linux.
The fixed launcher therefore starts a socat relay *before* seccomp, listening
only on 127.0.0.1:3129 **inside the new network namespace**, bound to the one
session Unix socket. `happy-mcp` speaks stdio to Claude and authenticated HTTP
through that relay. No host-loopback TCP endpoint is opened. The runtime uses
the same pre-seccomp relay mechanism for its HTTP/SOCKS proxies.

Claude uses session-private configuration/state under the MCP private directory,
backed by host private tmp and mounted into the sandbox. Only `.credentials.json`
is seeded (without following a credential-file symlink); settings/plugins are
not copied and filesystem setting sources are disabled. Refresh writes and
transcripts survive provider respawns in this session. State is removed when
the session MCP server closes. Shared Claude configuration is never written.

## Evidence and reproduction (2026-09-25)

Run from `packages/happy-cli` after installing the locked workspace dependencies:

```sh
pnpm typecheck
pnpm exec vitest run --project unit src/sandbox/claudeProcessSandbox.test.ts src/sandbox/claudeSdkSandbox.test.ts src/sandbox/config.test.ts src/sandbox/sandboxPolicy.test.ts src/claude/utils/mandatoryMcp.test.ts src/claude/utils/startHappyServer.test.ts src/claude/utils/path.test.ts src/claude/utils/claudeCheckSession.test.ts src/claude/claudeRemote.test.ts src/claude/claudeRemoteLauncher.test.ts src/claude/claudeRemoteManagedBoundary.test.ts src/claude/sdk/query.test.ts
DOCKER_BUILDKIT=0 docker build -t happy-s1-sandbox-smoke -f scripts/sandbox-linux-smoke.Dockerfile scripts
docker run --rm --privileged -v "$PWD/../..:/w:ro" happy-s1-sandbox-smoke
```

Final unit result: **200 passed, 1 existing platform skip across 12 files**.
`pnpm typecheck` passed. The unit command builds the package first (Vitest global setup). BuildKit was
unavailable because its host activity-file update was denied; the legacy local
builder worked. The container is privileged to allow nested bwrap, but the
fixture and sandbox execute as non-root `node`. The workspace is mounted
read-only. No `abp-exec`, real daemon directory, account key, API call or
production site is used. Test tokens and credential contents are synthetic.

Linux proof passes: eight concurrent real launches preserve empty/quoted/newline
argv; staged/Happy/stack canaries cannot be read; the launcher cannot be changed;
private proc/tmp and environment filtering hold; synthetic credential refresh
survives another spawn without changing its source; AF_UNIX creation is denied;
host loopback is unreachable; a disallowed domain returns proxy 403; the actual
packaged happy-mcp bridge lists exactly 13 permitted tools under seccomp;
cancellation produces an observed bwrap exit.

## Worktree handoff

Changes are in `feat/abp-s1-sandbox`'s assigned worktree. Commit creation was
blocked by `Operation not permitted` when Git tried to create the worktree
`index.lock` in the shared repository metadata outside this worktree. No commit,
push or production mutation occurred. The planned structural-only first commit
extracts the `runClaudeRemote` body; the behavior/tests/pins follow separately.
Both intended commit messages must end with:

```text
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

## Remaining deployment gates / explicit limitations

- **D1 is not fully closed:** sandbox-runtime 0.0.37 checks hostnames before
  HTTP CONNECT/HTTP/SOCKS connections, but exposes no connect-time resolved-IP
  policy. It can resolve an allowed name to a loopback, private, link-local or
  IPv6 ULA address. DNS rebinding protection is **not implemented or claimed**.
  Production needs a proxy that validates and pins resolved public addresses
  on every connection, or a runtime extension with equivalent behavior.
- Live Claude OAuth refresh and a real model turn were not run (real credentials
  were prohibited). Synthetic refresh verifies writable isolation and retention,
  not provider refresh semantics. Rotated refresh tokens are not copied back to
  shared auth; a new session needs valid bootstrap auth. Private transcripts do
  not survive session closure, so cross-session provider resume is not proven.
- This is the remote Claude path. Local-mode/provider transitions, a deployed
  systemd machine, production packaging/install permissions and real browser
  acceptance still need the deployment stream's validation. Existing hook
  callbacks to host loopback are intentionally unreachable; SDK events remain
  the remote session identity source.
- Package/private-path mounts and syscall filtering constrain sandboxed code.
  Same-UID hostile code already running outside the sandbox is outside this
  trust model. The domain exception above prevents a deployment-ready D1 claim.
