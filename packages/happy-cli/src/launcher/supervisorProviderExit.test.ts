/**
 * The provider's real exit, as the kernel reports it.
 *
 * A checkpoint that archives `provider-state` has to know the provider finished
 * writing, and neither provider's own shutdown path can say so: the Claude
 * Agent SDK's `waitForExit()` returns as soon as `process.killed` is set, which
 * Node sets on **signal delivery**, and Codex's `disconnect()` sends SIGKILL
 * after two seconds without waiting at all. So the exit has to be observed by
 * something that is not the provider's own client.
 *
 * The launcher already is that something. `exec-helper` calls `execv` with no
 * fork, so the process the supervisor spawned *is* the provider workload, and
 * its exit event carries the provider's own code and signal. Nothing captured
 * it, which is why `observeExit` had no possible implementation.
 *
 * This exercises the real `defaultSupervisorDeps.launch`, which nothing else
 * did: the exit observation is only worth anything if it comes from a spawn
 * this file did not simulate.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createGenerationManifest } from './generationManifest';
import { createSupervisor, defaultSupervisorDeps, type SupervisorDeps } from './supervisor';

const dirs: string[] = [];

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A stand-in for the helper: acknowledges on the status fd, then ends as told. */
function helperScript(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'sup-exit-'));
    dirs.push(dir);
    const path = join(dir, 'helper.sh');
    writeFileSync(path, `#!/bin/sh\nprintf 'ack=setup-complete pid=%s\\n' "$$" >&3\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
}

async function launched(body: string) {
    return defaultSupervisorDeps.launch({
        helperPath: helperScript(body),
        argv: [],
        statusFd: 3,
        releaseFd: 4,
        inheritFds: [],
        env: { PATH: '/usr/bin:/bin' },
    });
}

describe('the launched child\'s exit', () => {
    it('shouldReportTheWorkloadsOwnExitCode', async () => {
        // 3, not 0: a code that is merely "not zero" would also match a
        // fabricated one, and `exit-nonzero` is a refusal that has to be real.
        const handle = await launched('exit 3');
        expect(await handle.exited).toEqual({ code: 3, signal: null });
    });

    it('shouldReportASignalRatherThanAnExitCodeWhenTheChildIsKilled', async () => {
        // A killed provider did not flush. Reporting a code here — Node leaves
        // it `null` — would let a SIGKILL be classified as an ordinary exit.
        const handle = await launched('kill -9 $$');
        expect(await handle.exited).toEqual({ code: null, signal: 'SIGKILL' });
    });

    it('shouldNotResolveTheExitWhileTheChildIsStillRunning', async () => {
        // The whole point: `settled` resolves when the helper has said its
        // piece, which happens long before a long-running provider leaves.
        // Reading one for the other is how a running provider gets archived.
        // Not `await handle.settled` — the status fd stays open for as long
        // as the child lives, so that would be waiting for the exit by another
        // name. The handle is resolved at the ACK, which is the point.
        // `exec 3>&-` mirrors the real helper, which has CLOEXEC on the status
        // fd: its EOF arrives at execve, long before the workload ends. Without
        // that, this fake would hold the status pipe open for the child's whole
        // life and `settled` would happen to coincide with the exit — which is
        // exactly the coincidence the product must not depend on.
        const handle = await launched('exec 3>&-\nsleep 30');
        const race = await Promise.race([
            handle.exited!.then(() => 'exited'),
            new Promise((resolve) => setTimeout(() => resolve('still-running'), 150)),
        ]);
        expect(race).toBe('still-running');
        process.kill(handle.pid!, 'SIGKILL');
        expect(await handle.exited).toEqual({ code: null, signal: 'SIGKILL' });
    });
});

describe('a child that never started', () => {
    it('shouldRejectRatherThanInventAnExitAndShouldNotLeaveTheRejectionUnhandled', async () => {
        // `exit` never fires for a spawn that failed. Resolving with anything
        // would be reporting a termination that did not happen — and an
        // unobserved rejection is what takes the whole daemon down, so the
        // promise carries a handler of its own from birth.
        const handle = await defaultSupervisorDeps.launch({
            helperPath: join(tmpdir(), 'saycode-no-such-helper'),
            argv: [],
            statusFd: 3,
            releaseFd: 4,
            inheritFds: [],
            env: {},
        });
        await expect(handle.exited).rejects.toThrow();
    });
});

function inMemoryDeps(manifestRoot: string): SupervisorDeps {
    const dirs = new Set<string>();
    const files = new Map<string, string>();
    return {
        manifest: createGenerationManifest(manifestRoot),
        monotonicNow: () => 1_000,
        now: () => 1_800_000_000_000,
        mkdir: (path) => { dirs.add(path); },
        writeFile: (path, data) => { files.set(path, data); },
        readFile: (path) => {
            const value = files.get(path);
            if (value === undefined) throw new Error('missing');
            return value;
        },
        rmdir: (path) => { dirs.delete(path); },
        launch: defaultSupervisorDeps.launch,
        enrollWatchdog: () => {},
    };
}

describe('execGeneration hands the observed exit to its caller', () => {
    /**
     * The two halves — a spawn that can see the exit, and a caller that wants
     * it — are wired in `execGeneration`. Each half's own tests use a fake of
     * the other, so this is the only place the wire itself is exercised: a real
     * child, a real supervisor, and the cgroup interactions in memory.
     */
    it('shouldCallOnExitWithTheRealCodeAfterTheGenerationWasReleased', async () => {
        const manifestRoot = mkdtempSync(join(tmpdir(), 'sup-exit-manifest-'));
        dirs.push(manifestRoot);
        const deps = inMemoryDeps(manifestRoot);
        const supervisor = createSupervisor({
            cgroupRoot: join(manifestRoot, 'cgroup'),
            // The helper is the thing being launched, so here it is the script.
            helperPath: helperScript(
                // One byte, not a line: `release()` writes a bare `1` with no
                // newline, exactly as the real helper's `read(2)` expects.
                'exec 3>&-\ndd bs=1 count=1 <&4 >/dev/null 2>&1\nexit 3',
            ),
            workloadPath: '/usr/local/lib/saycode/node',
            resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
        }, deps);

        let seen: { code: number | null; signal: string | null } | null = null;
        let resolveExit: () => void = () => {};
        const observed = new Promise<void>((resolve) => { resolveExit = resolve; });

        const outcome = await supervisor.execGeneration({
            key: { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 },
            statusFd: 3,
            releaseFd: 4,
            leaseExpiresMonotonic: 60_000,
            onExit: (exit) => { seen = exit; resolveExit(); },
        });

        expect(outcome.kind).toBe('exec-attempted');
        await observed;
        expect(seen).toEqual({ code: 3, signal: null });
    });
});
