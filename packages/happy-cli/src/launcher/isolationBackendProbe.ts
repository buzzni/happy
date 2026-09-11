/**
 * Whether the trusted launch backend is actually wired up on this machine.
 *
 * This is the activation gate. Until it answers `verified`, a managed runtime
 * refuses to become one — and it has been answering "not implemented" since
 * T04, which is why no runtime has ever activated. Closing it is not a matter
 * of returning `true`: the whole point of the gate is that the axes the marker
 * *declares* are not the axes the machine *has*, and only the machine can say.
 *
 * ## What it checks, and why each one
 *
 * Every check is something whose absence silently removes an isolation
 * property while leaving the runtime looking configured:
 *
 * - **The two helpers exist, are root-owned, and are not writable by group or
 *   other.** They are the only reason any of this is isolation: they drop
 *   privilege and enter namespaces. A helper anything in the image could
 *   replace makes the trusted-exec check theatre.
 * - **They are two different programs.** `executorHelper` enters a per-call
 *   PID/mount/network namespace for one tool; `execHelper` enters none and runs
 *   the provider generation. Handing either one the other's job changes what
 *   the agent is isolated from without changing anything that reads as wrong.
 * - **The generation cgroup root is delegated and writable.** Without it a
 *   generation cannot be placed, cannot be counted, and — worse — cannot be
 *   killed as a unit, so `cgroup.kill` and the emptiness proof both stop
 *   meaning anything.
 * - **`cgroup.kill` and `cgroup.events` exist.** cgroup **v2**. On v1 the
 *   directory is writable and the fencing primitives are simply absent, which
 *   would read as a working delegation right up to the first stop.
 * - **provider, executor and the daemon are three different uids.** Shared uids
 *   mean the agent can signal, ptrace or read what it is supposed to be
 *   isolated from, and every other check here would still pass.
 *
 * ## Static is necessary, not sufficient
 *
 * All of the above is file state, and file state cannot show that the helper
 * *drops privilege*, *enters a namespace*, or is *killable as a unit*. Those
 * are the properties the runtime is trusted for, so `proveIsolationLaunch`
 * below launches a fixed probe through the real helper and then fences it.
 * Activation requires both halves.
 *
 * There is no environment variable, flag or configuration value that can make
 * this return `verified`. A gate with an override is not a gate.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
    accessSync,
    closeSync,
    constants,
    lstatSync,
    mkdirSync,
    openSync,
    readFileSync,
    readlinkSync,
    rmdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IsolationProbeResult } from '@/daemon/managedRuntimeIdentity';

/*
 * The image paths this gate needs, named here rather than imported from
 * `managedImagePackaging`.
 *
 * That module belongs to the image's runtime entry, which is bundled into
 * **one** read-only CommonJS file. Importing it from the daemon's identity
 * graph makes the bundler emit a sibling chunk that the image does not install,
 * so the file it does install fails to load — measured twice now. The drift
 * test in `isolationBackendProbe.test.ts` is what keeps these equal to the
 * image contract.
 */
export const MANAGED_TOOL_HELPER_IMAGE_PATH = '/usr/local/lib/saycode/executor-helper';
export const MANAGED_PROVIDER_HELPER_IMAGE_PATH = '/usr/local/lib/saycode/exec-helper';
export const MANAGED_ISOLATION_PROBE_PATH = '/usr/local/lib/saycode/isolation-probe';

/** The exact reason an activation was refused. Codes, never paths. */
export type IsolationProbeRefusal =
    | 'not-linux'
    | 'helper-missing'
    | 'helper-not-root-owned'
    | 'helper-writable'
    | 'helpers-not-distinct'
    | 'cgroup-root-missing'
    | 'cgroup-root-not-delegated'
    | 'cgroup-not-v2'
    | 'uids-not-separated';

export type IsolationProbeDeps = {
    platform: () => string;
    lstatPath: (path: string) => { uid: number; mode: number; isFile: boolean; isDirectory: boolean };
    /** Write access as the caller, which on a managed runtime is root. */
    canWrite: (path: string) => boolean;
    exists: (path: string) => boolean;
    /** The two trusted helpers, from the image contract. */
    toolHelperPath: string;
    providerHelperPath: string;
};

export const defaultIsolationProbeDeps = (input: {
    toolHelperPath: string;
    providerHelperPath: string;
}): IsolationProbeDeps => ({
    platform: () => process.platform,
    lstatPath: (path) => {
        const entry = lstatSync(path);
        return {
            uid: entry.uid,
            mode: entry.mode & 0o7777,
            isFile: entry.isFile(),
            isDirectory: entry.isDirectory(),
        };
    },
    canWrite: (path) => {
        try {
            accessSync(path, constants.W_OK);
            return true;
        } catch {
            return false;
        }
    },
    exists: (path) => {
        try {
            lstatSync(path);
            return true;
        } catch {
            return false;
        }
    },
    toolHelperPath: input.toolHelperPath,
    providerHelperPath: input.providerHelperPath,
});

function helperRefusal(
    path: string,
    deps: IsolationProbeDeps,
): IsolationProbeRefusal | null {
    let entry: { uid: number; mode: number; isFile: boolean };
    try {
        entry = deps.lstatPath(path);
    } catch {
        return 'helper-missing';
    }
    if (!entry.isFile) return 'helper-missing';
    if (entry.uid !== 0) return 'helper-not-root-owned';
    // Group or other write is the whole question: the helper validates what it
    // is told to exec, and that check is only as good as the file itself.
    if ((entry.mode & 0o022) !== 0) return 'helper-writable';
    return null;
}

/**
 * The static preconditions, and **only** those.
 *
 * It deliberately does not return an `IsolationProbeResult`: it returns
 * `{ ok: true }`, which nothing can hand to `probeIsolationBackend` as an
 * answer. That shape is the point. An earlier version of this file returned
 * the probe result directly, a call site wired it to production, and the
 * outcome was a machine that could activate on file state alone — helpers with
 * the right mode, a writable cgroup root, three uids, and no evidence that
 * anything had ever been launched or fenced.
 *
 * Preventing that by remembering not to wire it is not prevention. Only
 * `verifyIsolationBackend` below, which runs the launch and the fence too, can
 * produce a `verified: true`.
 */
export function checkIsolationStaticPreconditions(input: {
    provider: { uid: number; gid: number };
    executor: { uid: number; gid: number };
    cgroupRoot: string;
    daemonUid: number;
    deps: IsolationProbeDeps;
}): { ok: true } | { ok: false; reason: IsolationProbeRefusal } {
    const { deps } = input;
    // Namespaces, cgroup v2 and uid separation are Linux facts. Everywhere else
    // this is not "unverified pending work" — it cannot be true.
    if (deps.platform() !== 'linux') {
        return { ok: false, reason: 'not-linux' };
    }

    for (const path of [deps.toolHelperPath, deps.providerHelperPath]) {
        const refusal = helperRefusal(path, deps);
        if (refusal) return { ok: false, reason: refusal };
    }
    if (deps.toolHelperPath === deps.providerHelperPath) {
        return { ok: false, reason: 'helpers-not-distinct' };
    }

    let root: { isDirectory: boolean };
    try {
        root = deps.lstatPath(input.cgroupRoot);
    } catch {
        return { ok: false, reason: 'cgroup-root-missing' };
    }
    if (!root.isDirectory) {
        return { ok: false, reason: 'cgroup-root-missing' };
    }
    if (!deps.canWrite(input.cgroupRoot)) {
        return { ok: false, reason: 'cgroup-root-not-delegated' };
    }
    // v1 gives a writable directory with none of the fencing primitives, which
    // would read as a working delegation until the first stop had to prove
    // something.
    for (const control of ['cgroup.kill', 'cgroup.events']) {
        if (!deps.exists(join(input.cgroupRoot, control))) {
            return { ok: false, reason: 'cgroup-not-v2' };
        }
    }

    const uids = new Set([input.provider.uid, input.executor.uid, input.daemonUid]);
    if (uids.size !== 3) {
        return { ok: false, reason: 'uids-not-separated' };
    }

    return { ok: true };
}

/**
 * The dynamic half: the machine is asked to actually do the thing.
 *
 * Everything above is necessary and none of it is sufficient. A helper that
 * exists with the right mode has not been shown to drop privilege, enter a
 * namespace, or be killable as a unit — and those are the properties the
 * runtime is trusted for. So this launches the fixed probe through the **real**
 * `executorHelper`, reads what it reports about the environment it got, and
 * then proves the generation can be fenced: `cgroup.kill`, `populated 0`, and
 * the directory removed.
 *
 * ## Why it is synchronous
 *
 * `probeIsolationBackend` is a synchronous contract, and identity resolution is
 * synchronous all the way down to its callers. Making this async to run a child
 * process would turn that whole chain async for one boot-time question, so the
 * probe is spawned with `spawnSync` and a timeout instead — bounded, and the
 * timeout is reported as a timeout rather than as an empty report.
 *
 * ## Why it does not ask the supervisor
 *
 * Boot requires an active identity *before* it starts the supervisor, so a
 * probe that needed the supervisor's answer would be a cycle. This uses the
 * helper directly, which is available to root at boot.
 *
 * ## What it touches
 *
 * One directory it creates under the runtime's own cgroup root, and nothing
 * else. It never moves host processes or an existing generation's pids: a bulk
 * move is how a probe takes down the very things it was meant to check.
 */
export type IsolationLaunchRefusal =
    | 'probe-launch-failed'
    | 'probe-timed-out'
    | 'probe-uid-not-applied'
    | 'probe-namespace-not-applied'
    | 'probe-cgroup-not-applied'
    | 'fence-not-proven'
    | 'probe-children-remain';

export type IsolationLaunchDeps = {
    /**
     * Runs the helper to completion, bounded, and returns the probe's report.
     *
     * `report` is what the probe wrote on its own descriptor; `code` is the
     * helper's exit status. A timeout is `timedOut`, never a silent empty
     * report — the two mean different things about the machine.
     */
    runHelper: (input: {
        helperPath: string;
        cgroupPath: string;
        uid: number;
        gid: number;
        execPath: string;
        timeoutMs: number;
    }) => { timedOut: boolean; code: number | null; report: string };
    /** Creates the probe's own cgroup. Never reuses a generation's. */
    makeCgroup: (path: string) => void;
    /** Asks the kernel to kill everything in it. */
    killCgroup: (path: string) => void;
    /** `cgroup.events`, so emptiness is observed rather than assumed. */
    readEvents: (path: string) => string;
    /** Removing it is the kernel confirming it is empty. */
    removeCgroup: (path: string) => void;
};

export function parseIsolationProbeReport(report: string): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const line of report.split('\n')) {
        const split = line.indexOf('=');
        if (split <= 0) continue;
        fields[line.slice(0, split).trim()] = line.slice(split + 1).trim();
    }
    return fields;
}

export function proveIsolationLaunch(input: {
    executor: { uid: number; gid: number };
    cgroupRoot: string;
    probeCgroupName: string;
    toolHelperPath: string;
    probePath: string;
    timeoutMs: number;
    /** This process's own network namespace, to compare the probe's against. */
    callerNetns: string;
    deps: IsolationLaunchDeps;
}): { verified: true } | { verified: false; reason: IsolationLaunchRefusal } {
    const cgroupPath = join(input.cgroupRoot, input.probeCgroupName);
    const { deps } = input;
    try {
        deps.makeCgroup(cgroupPath);
    } catch {
        return { verified: false, reason: 'probe-launch-failed' };
    }

    let outcome: { timedOut: boolean; code: number | null; report: string };
    try {
        outcome = deps.runHelper({
            helperPath: input.toolHelperPath,
            cgroupPath,
            uid: input.executor.uid,
            gid: input.executor.gid,
            execPath: input.probePath,
            timeoutMs: input.timeoutMs,
        });
    } catch {
        // The fence still runs: a launch that failed may still have left
        // something behind, and leaving it is worse than the failed probe.
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-launch-failed' });
    }

    if (outcome.timedOut) {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-timed-out' });
    }
    if (outcome.code !== 0) {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-launch-failed' });
    }

    const fields = parseIsolationProbeReport(outcome.report);
    if (fields.ok !== '1') {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-launch-failed' });
    }
    // Privilege was actually dropped, not merely requested.
    if (fields.uid !== String(input.executor.uid)) {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-uid-not-applied' });
    }
    // In a PID namespace the probe is pid 1. Outside one it is not, and the
    // helper's `unshare` did not take.
    if (fields.pid !== '1') {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-namespace-not-applied' });
    }
    /*
     * A fresh network namespace has loopback and nothing else, asked over
     * netlink.
     *
     * Not from `/sys/class/net`: sysfs shows the interfaces of the namespace
     * its mount was created in, and the helper does not remount `/sys` after
     * unsharing — so that directory reports the host's `eth0` for a correctly
     * isolated tool. Measured on a real machine, which is how this was found.
     */
    const interfaces = (fields.ifaces ?? '').split(',').filter((entry) => entry !== '');
    if (interfaces.length !== 1 || interfaces[0] !== 'lo') {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-namespace-not-applied' });
    }
    // And it is a different namespace from this process's, so "only loopback"
    // cannot be satisfied by a host that happens to have no other interface.
    if (!/^net:\[\d+\]$/.test(fields.netns ?? '') || fields.netns === input.callerNetns) {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-namespace-not-applied' });
    }
    // It ran inside the cgroup it was placed in, so a stop reaches it.
    if (!(fields.cgroup ?? '').includes(input.probeCgroupName)) {
        return finish(deps, cgroupPath, { verified: false, reason: 'probe-cgroup-not-applied' });
    }

    return finish(deps, cgroupPath, { verified: true });
}

/**
 * Fences the probe's generation and proves it empty, whatever the outcome was.
 *
 * A probe that verified everything and left a process behind has not shown the
 * machine can fence — and the leftover is running as the executor uid inside a
 * cgroup nobody will look at again.
 */
function finish(
    deps: IsolationLaunchDeps,
    cgroupPath: string,
    outcome: { verified: true } | { verified: false; reason: IsolationLaunchRefusal },
): { verified: true } | { verified: false; reason: IsolationLaunchRefusal } {
    try {
        deps.killCgroup(cgroupPath);
    } catch {
        return { verified: false, reason: 'fence-not-proven' };
    }
    let events: string;
    try {
        events = deps.readEvents(cgroupPath);
    } catch {
        return { verified: false, reason: 'fence-not-proven' };
    }
    if (!/^populated 0$/m.test(events)) {
        return { verified: false, reason: 'probe-children-remain' };
    }
    try {
        // The kernel refuses `rmdir` on a populated cgroup, so this succeeding
        // is the emptiness being confirmed a second time by a different means.
        deps.removeCgroup(cgroupPath);
    } catch {
        return { verified: false, reason: 'probe-children-remain' };
    }
    return outcome;
}

/**
 * The whole gate. The only function here that can answer `verified: true`.
 *
 * Static preconditions **and** a real launch through the real helper **and** a
 * real fence. Each half is necessary; neither is sufficient, and neither is
 * reachable as an activation answer on its own — the static half returns a
 * shape that is not an `IsolationProbeResult`, so a call site cannot wire it to
 * production by mistake. That mistake was made once: an earlier revision
 * exported the static check as the probe result, it reached a production
 * default, and a machine could have activated having never launched anything.
 */
export function verifyIsolationBackend(input: {
    provider: { uid: number; gid: number };
    executor: { uid: number; gid: number };
    cgroupRoot: string;
    daemonUid: number;
    probeCgroupName: string;
    probePath: string;
    timeoutMs: number;
    callerNetns: string;
    deps: IsolationProbeDeps;
    launchDeps: IsolationLaunchDeps;
}): IsolationProbeResult {
    const preconditions = checkIsolationStaticPreconditions({
        provider: input.provider,
        executor: input.executor,
        cgroupRoot: input.cgroupRoot,
        daemonUid: input.daemonUid,
        deps: input.deps,
    });
    if (!preconditions.ok) return { verified: false, reason: preconditions.reason };

    const launch = proveIsolationLaunch({
        executor: input.executor,
        cgroupRoot: input.cgroupRoot,
        probeCgroupName: input.probeCgroupName,
        toolHelperPath: input.deps.toolHelperPath,
        probePath: input.probePath,
        timeoutMs: input.timeoutMs,
        callerNetns: input.callerNetns,
        deps: input.launchDeps,
    });
    if (!launch.verified) return { verified: false, reason: launch.reason };
    return { verified: true };
}

/**
 * The real machine's answers.
 *
 * The helper is spawned with `spawnSync` and a timeout: bounded, and the probe
 * writes its report on descriptor 5, which the helper is told to keep. Nothing
 * comes back on stdout — that is the helper's own ACK protocol, and mixing the
 * two would make the report parse whatever the helper happened to say.
 */
export function defaultIsolationLaunchDeps(): IsolationLaunchDeps {
    return {
        runHelper: ({ helperPath, cgroupPath, uid, gid, execPath, timeoutMs }) => {
            const scratch = (suffix: string) =>
                join(tmpdir(), `saycode-isolation-${randomBytes(8).toString('hex')}.${suffix}`);
            // `wx` on every one: this probe owns these paths, and appending to
            // somebody else's file would report their answers as its own.
            const reportPath = scratch('report');
            const statusPath = scratch('status');
            const gatePath = scratch('gate');
            /*
             * The release gate is a file with a byte already in it.
             *
             * The helper parks and then *reads* the release descriptor before
             * it execs. A pipe nobody writes to leaves it parked until the
             * timeout — which reads as "this machine cannot launch" when the
             * only thing wrong is that nothing opened the gate. There is no
             * daemon to register this launch, so the gate is open from the
             * start.
             */
            writeFileSync(gatePath, 'x', { mode: 0o600, flag: 'wx' });
            const reportFd = openSync(reportPath, 'wx', 0o600);
            const statusFd = openSync(statusPath, 'wx', 0o600);
            const gateFd = openSync(gatePath, 'r');
            try {
                const outcome = spawnSync(helperPath, [
                    // status fd, release fd, cgroup, uid, gid, nkeep, kept fds, exe
                    '9', '8', cgroupPath, String(uid), String(gid), '1', '5', execPath,
                ], {
                    timeout: timeoutMs,
                    killSignal: 'SIGKILL',
                    stdio: [
                        'ignore', 'ignore', 'ignore',
                        'ignore', 'ignore', reportFd,
                        'ignore', 'ignore',
                        gateFd, statusFd,
                    ],
                });
                return {
                    // `spawnSync` reports the kill it performed, which is how a
                    // hung probe is told apart from one that failed fast.
                    timedOut: (outcome as { signal?: string | null }).signal === 'SIGKILL'
                        && outcome.status === null,
                    code: outcome.status,
                    report: readFileSync(reportPath, 'utf8'),
                };
            } finally {
                for (const fd of [reportFd, statusFd, gateFd]) {
                    try { closeSync(fd); } catch { /* already closed */ }
                }
                for (const path of [reportPath, statusPath, gatePath]) {
                    try { unlinkSync(path); } catch { /* already gone */ }
                }
            }
        },
        makeCgroup: (path) => { mkdirSync(path, { recursive: false, mode: 0o755 }); },
        killCgroup: (path) => { writeFileSync(join(path, 'cgroup.kill'), '1'); },
        readEvents: (path) => readFileSync(join(path, 'cgroup.events'), 'utf8'),
        removeCgroup: (path) => { rmdirSync(path); },
    };
}

/** This process's network namespace, for the probe to be compared against. */
export function callerNetworkNamespace(): string {
    return readlinkSync('/proc/self/ns/net');
}
