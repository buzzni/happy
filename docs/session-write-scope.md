# Local session folder write approval (source candidate)

macOS and namespace-capable Linux Desktop-owned standalone daemons advertise sessionWriteScope.version=1 to newly marked protected Codex and Claude remote sessions. This source candidate is not a published CLI or Desktop pin. Mandatory shared machines, Claude local, legacy/external/cloud/Windows/checkpoint/credential-staged sessions are unsupported. Linux packaging and remote host approval are separate acceptance work.

## Authority and lifecycle

Desktop main keeps an incarnation-specific Ed25519 private key in memory; only public bootstrap reaches the daemon. The daemon owns immutable requests/digests. Human decisions bind account/machine/session/incarnation/request/digest. The shared loopback bearer never proves approval.

session_write_scope exposes request/list/cancel, without approve or command execution. Requests contain a short secret-free description and narrow absolute folder. Canonical existing parent, dev/ino, protected floor, previous roots and expiry are rechecked before replacement. Home/root/protected grants are refused; existing sandbox deny/read/network/mandatory policy remains. Children inherit it.

Approval consumption is journaled before async work. One replacement preserves original config/encryption/cursor and uses the existing authenticated launch drain: freeze input, finish provider EOF/output, confirm storage and acknowledge the final frozen cursor at the daemon. It then awaits actual owned ChildProcess exit without using a best-effort SIGTERM as preservation proof. Live-child resume no-op cannot acknowledge application. Roots/expiry are validated immediately before spawn. Real sandbox/app-server initialization must post a token/digest/session/PID receipt for profileApplied.

Marked launches report with an independent launch secret on inherited FD 3. The parent consumes/closes it before providers/MCP. The same private pipe separately carries the authenticated drain bootstrap, without giving that credential to provider environments. Signed whole body/kind/session/PID/expiry/increasing sequence prevents shared-bearer forgery. Exit revokes report authority; restored marked sessions without launch authority fail closed. This is not descendant termination evidence.

Marked parents do not expose privileged bash_stream/script automations/raw browser tools. Checkpoint sessions remain unmarked to preserve their existing writer contract.

## State and recovery

pending → applying → applied | failed | cleanup-unresolved, with cancelled/project-local/expired alternatives. profileApplied confirms the replacement; grantActive describes memory roots. Root exit/command completion never proves full revocation. Stop/receipt uncertainty stays cleanup-unresolved. Reviewed revoke removes future reuse and resumes baseline/remaining roots; installed files are preserved.

session-write-scope.json holds bounded owner-only public evidence using private temporary file/fsync/atomic rename/directory fsync. No key/permit/grant is restored. Restart expires pending, preserves uncertain application and resets grantActive. ACK loss is reconciled by list, without automatic reapplication.

Broker/journal initialization failure disables approval support while allowing ordinary daemon startup. It never grants write access or falls back to an unprotected launch.

## Validation and release

Related unit tests cover signatures/replay/expiry/intent failure, paths/replacement/lineage/report authority/control/Codex/MCP admission. Actual macOS tests verify approved and inherited child writes, denied siblings/symlinks/credentials and revoked new profile. Native Codex tests use isolated homes and initialize/EOF without model turns.

HAPPY_SCOPE_NATIVE_CODEX=1 pnpm exec vitest run --project unit src/daemon/sessionWriteScopeRuntime.test.ts exercises actual control server/authenticated owned parent/native sandboxed provider/receipt for allow/replay/forgery/revoke. Preserve/resume/storage callbacks assert fixture identity/cursor, not real server encrypted-transcript reconnect. Provider EOF, authenticated drain release, owned root exit and protected profile receipt are actual native paths. That smoke and published artifact install/rollback plus Desktop pin acceptance remain release work. Source validation does not publish/change pins/replace a running user daemon.

## Claude and Linux source extension

Claude consumes the report/drain pipe and takes confirmation material before any provider/MCP transport. One immutable outer OS boundary covers every SDK generation. It performs native SDK control initialization without a model turn, closes the probe input, verifies actual exit, then acknowledges the prepared profile. Subsequent generations use the same protected spawn; switching to local is refused. The existing authenticated Claude drain additionally requires the frozen cursor daemon ACK for these launches.

Linux capability requires an actual user/pid/network namespace probe with /usr/bin/bwrap; each provider independently verifies execution through its exact profile. Failure disables support. Mandatory machine policy keeps its existing UID/managed enforcement path. Actual isolated Linux tests cover native Claude initialization, pre-grant denial, allowed/inherited writes, denied sibling/symlink writes, unchanged host credentials/unreadable original contents, and revoked new profile denial. Linux read-denied directories are private tmpfs, so shadow writes can succeed without changing the host credential; errno alone is insufficient evidence. Native Linux Codex initialization and EOF exit 0 passed for baseline/allow/revoke profiles. The capable test container supplied namespaces explicitly; an ordinary container confirmed support=false. Neither path is a product fallback or deployment.

Native tests can be selected with HAPPY_SCOPE_NATIVE_CLAUDE=1 and HAPPY_SCOPE_NATIVE_CODEX=1; Linux additionally needs HAPPY_SCOPE_NATIVE_LINUX=1 and actually working namespace prerequisites. Runtime/control preserve/resume/storage remain fixture callbacks. Windows support remains disabled. The approved Desktop AppContainer+Job fixture prototype failed native acceptance: an inheritable SID ACE propagated through a hardlink to the fixture credential inode; Codex initialization and descendant/loopback acceptance were also incomplete. No Windows product backend or v2 DTO was integrated. Native evidence does not prove published artifact installation or server transcript reconnect.


## PR integration verification (2026-10-03)

The source work was committed as 8850cfa97 and integrated with current origin/main bccc390c7. Conflicts in scope MCP registration, launch bootstrap and daemon imports preserve both scope enforcement and the new bounded Codex host recall. Related tests after integration passed: 22 files/844 tests including native Codex/Claude and OS/control receipt paths; five drain/producer direct-consumer files/59 tests. Vitest global setup completed TypeScript and pkgroll builds. No global install, tag, publish, provider model turn, production server transcript smoke or Desktop scope release pin was performed. Untracked dependency symlinks are not committed.
