/**
 * The activation gate.
 *
 * It has answered "not implemented" since T04, so no managed runtime has ever
 * activated. Every case below is a machine that *looks* configured and is
 * missing one isolation property — the gate exists to tell those apart from a
 * machine that is actually set up.
 */
import { describe, expect, it } from 'vitest';

import {
    defaultIsolationProbeDeps,
    checkIsolationStaticPreconditions,
    proveIsolationLaunch,
    verifyIsolationBackend,
    MANAGED_ISOLATION_PROBE_PATH,
    MANAGED_PROVIDER_HELPER_IMAGE_PATH,
    MANAGED_TOOL_HELPER_IMAGE_PATH,
    type IsolationLaunchDeps,
    type IsolationProbeDeps,
} from './isolationBackendProbe';

const TOOL = '/usr/local/lib/saycode/executor-helper';
const PROVIDER = '/usr/local/lib/saycode/exec-helper';
const CGROUP = '/sys/fs/cgroup/saycode';

function deps(over: Partial<IsolationProbeDeps> = {}): IsolationProbeDeps {
    const files: Record<string, { uid: number; mode: number; isFile: boolean; isDirectory: boolean }> = {
        [TOOL]: { uid: 0, mode: 0o500, isFile: true, isDirectory: false },
        [PROVIDER]: { uid: 0, mode: 0o500, isFile: true, isDirectory: false },
        [CGROUP]: { uid: 0, mode: 0o755, isFile: false, isDirectory: true },
    };
    const present = new Set([`${CGROUP}/cgroup.kill`, `${CGROUP}/cgroup.events`]);
    return {
        platform: () => 'linux',
        lstatPath: (path) => {
            const entry = files[path];
            if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
            return entry;
        },
        canWrite: () => true,
        exists: (path) => present.has(path) || path in files,
        toolHelperPath: TOOL,
        providerHelperPath: PROVIDER,
        ...over,
    };
}

const probe = (over: Partial<IsolationProbeDeps> = {}) => checkIsolationStaticPreconditions({
    provider: { uid: 10601, gid: 10601 },
    executor: { uid: 10602, gid: 10600 },
    cgroupRoot: CGROUP,
    daemonUid: 10000,
    deps: deps(over),
});

describe('probeIsolationBackend', () => {
    it('shouldVerifyAMachineThatActuallyHasEveryAxis', () => {
        expect(probe()).toEqual({ ok: true });
    });

    it('shouldRefuseAnywhereThatIsNotLinux', () => {
        // Not "pending work": namespaces, cgroup v2 and uid separation cannot
        // be true here at all.
        expect(probe({ platform: () => 'darwin' }))
            .toEqual({ ok: false, reason: 'not-linux' });
    });

    it('shouldRefuseAMissingHelper', () => {
        expect(probe({ lstatPath: () => { throw new Error('ENOENT'); } }))
            .toEqual({ ok: false, reason: 'helper-missing' });
    });

    it('shouldRefuseAHelperAnythingInTheImageCouldReplace', () => {
        /*
         * The helper validates what it is told to exec. That check is only as
         * good as the file, so group or other write makes it theatre.
         */
        const files = {
            [TOOL]: { uid: 0, mode: 0o555 | 0o020, isFile: true, isDirectory: false },
            [PROVIDER]: { uid: 0, mode: 0o500, isFile: true, isDirectory: false },
            [CGROUP]: { uid: 0, mode: 0o755, isFile: false, isDirectory: true },
        };
        expect(probe({ lstatPath: (p) => files[p as keyof typeof files]! }))
            .toEqual({ ok: false, reason: 'helper-writable' });
    });

    it('shouldRefuseAHelperThatIsNotRootOwned', () => {
        const files = {
            [TOOL]: { uid: 1000, mode: 0o500, isFile: true, isDirectory: false },
            [PROVIDER]: { uid: 0, mode: 0o500, isFile: true, isDirectory: false },
            [CGROUP]: { uid: 0, mode: 0o755, isFile: false, isDirectory: true },
        };
        expect(probe({ lstatPath: (p) => files[p as keyof typeof files]! }))
            .toEqual({ ok: false, reason: 'helper-not-root-owned' });
    });

    it('shouldRefuseOneProgramDoingBothJobs', () => {
        // `executorHelper` enters a per-call PID/mount/network namespace;
        // `execHelper` enters none. One file cannot be both.
        expect(probe({ providerHelperPath: TOOL }))
            .toEqual({ ok: false, reason: 'helpers-not-distinct' });
    });

    it('shouldRefuseACgroupRootThatIsNotDelegated', () => {
        // Not writable means a generation cannot be placed, counted, or killed
        // as a unit — so no stop can ever be proven.
        expect(probe({ canWrite: () => false }))
            .toEqual({ ok: false, reason: 'cgroup-root-not-delegated' });
    });

    it('shouldRefuseCgroupV1EvenThoughTheDirectoryIsWritable', () => {
        /*
         * v1 has the directory and none of the fencing primitives, so it reads
         * as a working delegation right up to the first stop that has to prove
         * something.
         */
        expect(probe({ exists: (p) => !p.endsWith('cgroup.kill') }))
            .toEqual({ ok: false, reason: 'cgroup-not-v2' });
    });

    it('shouldRefuseWhenTwoOfTheThreeIdentitiesAreTheSameUid', () => {
        expect(checkIsolationStaticPreconditions({
            provider: { uid: 10601, gid: 10601 },
            // The executor shares the provider's uid: it can signal, ptrace and
            // read exactly what it is meant to be isolated from.
            executor: { uid: 10601, gid: 10600 },
            cgroupRoot: CGROUP,
            daemonUid: 10000,
            deps: deps(),
        })).toEqual({ ok: false, reason: 'uids-not-separated' });
    });

    it('shouldHaveNoOverrideThatMakesItVerify', () => {
        // Every refusal above is reachable only by changing the machine. There
        // is no flag, env var or option in the surface at all.
        const surface = Object.keys(defaultIsolationProbeDeps({
            toolHelperPath: TOOL, providerHelperPath: PROVIDER,
        }));
        expect(surface).toEqual([
            'platform', 'lstatPath', 'canWrite', 'exists', 'toolHelperPath', 'providerHelperPath',
        ]);
    });
});

describe('proveIsolationLaunch', () => {
    const GOOD_REPORT = [
        'uid=10602', 'gid=10600',
        'cgroup=0::/saycode/activation-probe',
        'pid=1', 'ifaces=lo,', 'netns=net:[4026534880]', 'ok=1',
    ].join('\n');

    function launchDeps(over: Partial<IsolationLaunchDeps> = {}) {
        const events: string[] = [];
        const deps: IsolationLaunchDeps = {
            runHelper: () => ({ timedOut: false, code: 0, report: GOOD_REPORT }),
            makeCgroup: (p) => { events.push(`make:${p}`); },
            killCgroup: (p) => { events.push(`kill:${p}`); },
            readEvents: () => 'populated 0\nfrozen 0\n',
            removeCgroup: (p) => { events.push(`rmdir:${p}`); },
            ...over,
        };
        return { events, deps };
    }

    const prove = (over: Partial<IsolationLaunchDeps> = {}) => {
        const { events, deps } = launchDeps(over);
        const result = proveIsolationLaunch({
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: '/sys/fs/cgroup/saycode',
            probeCgroupName: 'activation-probe',
            toolHelperPath: TOOL,
            probePath: '/usr/local/lib/saycode/isolation-probe',
            timeoutMs: 5_000,
            callerNetns: 'net:[4026534835]',
            deps,
        });
        return { result, events };
    };

    it('shouldVerifyOnlyAfterARealLaunchAndARealFence', async () => {
        const { result, events } = prove();
        expect(result).toEqual({ verified: true });
        // Killed and proven empty even on the success path: a probe that
        // verified everything and left a process behind has not shown the
        // machine can fence.
        expect(events).toEqual([
            'make:/sys/fs/cgroup/saycode/activation-probe',
            'kill:/sys/fs/cgroup/saycode/activation-probe',
            'rmdir:/sys/fs/cgroup/saycode/activation-probe',
        ]);
    });

    it('shouldRefuseWhenPrivilegeWasNeverActuallyDropped', async () => {
        const { result } = prove({
            runHelper: () => ({
                timedOut: false, code: 0,
                report: GOOD_REPORT.replace('uid=10602', 'uid=0'),
            }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-uid-not-applied' });
    });

    it('shouldRefuseWhenTheHelperDidNotEnterAPidNamespace', async () => {
        const { result } = prove({
            runHelper: () => ({
                timedOut: false, code: 0, report: GOOD_REPORT.replace('pid=1', 'pid=4242'),
            }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-namespace-not-applied' });
    });

    it('shouldRefuseWhenTheToolWouldShareTheHostsNetwork', async () => {
        // A fresh network namespace has loopback and nothing else.
        const { result } = prove({
            runHelper: () => ({
                timedOut: false, code: 0, report: GOOD_REPORT.replace('ifaces=lo,', 'ifaces=lo,eth0,'),
            }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-namespace-not-applied' });
    });

    it('shouldRefuseWhenTheProbeSharedThisProcessesNetworkNamespace', async () => {
        /*
         * "Only loopback" is not enough on its own: a host with no other
         * interface would satisfy it while the namespace never applied. The
         * inode has to differ too.
         */
        const { result } = prove({
            runHelper: () => ({
                timedOut: false, code: 0,
                report: GOOD_REPORT.replace('net:[4026534880]', 'net:[4026534835]'),
            }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-namespace-not-applied' });
    });

    it('shouldRefuseWhenTheProbeRanOutsideTheCgroupItWasPlacedIn', async () => {
        const { result } = prove({
            runHelper: () => ({
                timedOut: false, code: 0,
                report: GOOD_REPORT.replace('/saycode/activation-probe', '/'),
            }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-cgroup-not-applied' });
    });

    it('shouldRefuseATimeoutRatherThanReadItAsAnEmptyReport', async () => {
        const { result, events } = prove({
            runHelper: () => ({ timedOut: true, code: null, report: '' }),
        });
        expect(result).toEqual({ verified: false, reason: 'probe-timed-out' });
        // And it is still fenced: a probe that hung may have left something.
        expect(events).toContain('kill:/sys/fs/cgroup/saycode/activation-probe');
    });

    it('shouldRefuseWhenTheGenerationCouldNotBeProvenEmpty', async () => {
        const { result } = prove({ readEvents: () => 'populated 1\nfrozen 0\n' });
        expect(result).toEqual({ verified: false, reason: 'probe-children-remain' });
    });

    it('shouldRefuseWhenTheCgroupCannotBeRemoved', async () => {
        // The kernel refuses rmdir on a populated cgroup, so this failing after
        // `populated 0` means something reappeared.
        const { result } = prove({
            removeCgroup: () => { throw new Error('EBUSY'); },
        });
        expect(result).toEqual({ verified: false, reason: 'probe-children-remain' });
    });

    it('shouldFenceEvenWhenTheLaunchItselfFailed', async () => {
        const { result, events } = prove({
            runHelper: () => { throw new Error('spawn failed'); },
        });
        expect(result).toEqual({ verified: false, reason: 'probe-launch-failed' });
        expect(events).toContain('kill:/sys/fs/cgroup/saycode/activation-probe');
    });

    it('shouldTouchOnlyItsOwnCgroupAndNeverMoveExistingPids', async () => {
        const { events } = prove();
        // A bulk move is how a probe takes down the very things it checks.
        expect(events.every((event) => event.endsWith('/activation-probe'))).toBe(true);
    });
});

describe('the static half cannot activate anything on its own', () => {
    it('shouldNotEvenReturnAShapeAProbeSiteCouldUseAsAnAnswer', () => {
        /*
         * This is the regression for a mistake that actually reached a
         * production default: the static check used to return the probe result
         * itself, so wiring it activated machines that had never launched or
         * fenced anything. It now returns `{ok}`, which is not an
         * `IsolationProbeResult` — the type system refuses the wiring rather
         * than a reviewer having to catch it.
         */
        const outcome = checkIsolationStaticPreconditions({
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: CGROUP,
            daemonUid: 10000,
            deps: deps(),
        });
        expect(outcome).toEqual({ ok: true });
        expect(outcome).not.toHaveProperty('verified');
    });

    it('shouldRequireBothHalvesBeforeItVerifies', async () => {
        const launchDeps: IsolationLaunchDeps = {
            runHelper: () => ({
                timedOut: false, code: 0,
                report: 'uid=10602\ngid=10600\ncgroup=0::/saycode/p\npid=1\nifaces=lo,\nnetns=net:[1]\nok=1',
            }),
            makeCgroup: () => undefined,
            killCgroup: () => undefined,
            readEvents: () => 'populated 0\n',
            removeCgroup: () => undefined,
        };
        const args = {
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: CGROUP,
            daemonUid: 10000,
            probeCgroupName: 'p',
            probePath: '/usr/local/lib/saycode/isolation-probe',
            timeoutMs: 5_000,
            callerNetns: 'net:[2]',
            deps: deps(),
            launchDeps,
        };
        expect(verifyIsolationBackend(args)).toEqual({ verified: true });

        // Static passes, launch does not: still refused.
        expect(verifyIsolationBackend({
            ...args,
            launchDeps: { ...launchDeps, readEvents: () => 'populated 1\n' },
        })).toEqual({ verified: false, reason: 'probe-children-remain' });

        // Launch would pass, static does not: refused before anything is run.
        let launched = 0;
        expect(verifyIsolationBackend({
            ...args,
            deps: deps({ canWrite: () => false }),
            launchDeps: { ...launchDeps, runHelper: () => { launched += 1; throw new Error('x'); } },
        })).toEqual({ verified: false, reason: 'cgroup-root-not-delegated' });
        expect(launched).toBe(0);
    });
});

describe('isolationProbePathsAgreeWithTheImageContract', () => {
    it('shouldNameTheSameFilesTheImageInstalls', async () => {
        /*
         * Named twice because importing the image contract into the daemon's
         * identity graph splits the image's own runtime bundle — the entry then
         * requires a sibling chunk the image never installs. Measured twice.
         * This is what stops the two copies drifting: a drift means the gate
         * checks a file the image does not have.
         */
        const image = await import('@/managed/managedImagePackaging');
        expect(MANAGED_TOOL_HELPER_IMAGE_PATH).toBe(image.MANAGED_TOOL_HELPER_IMAGE_PATH);
        expect(MANAGED_PROVIDER_HELPER_IMAGE_PATH).toBe(image.MANAGED_PROVIDER_HELPER_IMAGE_PATH);
        expect(MANAGED_ISOLATION_PROBE_PATH).toBe(image.MANAGED_ISOLATION_PROBE_PATH);
    });
});
