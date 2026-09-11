import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createGenerationManifest, generationScopeDigest } from './generationManifest';
import {
    acquireSupervisorLock,
    supervisorLockAddress,
    classifyHelperStatus,
    createLeaseWatchdog,
    createSupervisor,
    defaultSupervisorDeps,
    generationCgroupPath,
    type SupervisorDeps,
} from './supervisor';

const KEY = { runId: 'run-1', attemptId: 'attempt-1', epoch: 2 };
const NOW = 1_800_000_000_000;
const LEASE = 60_000;

/** ACK 를 낸 뒤 park 된 helper. release/abort 가 결과를 정한다. */
function parkedHandle(pid: number, over: { onRelease?: string; onAbort?: string } = {}) {
    let resolve: (value: { status: string; pid: number | null }) => void = () => {};
    const settled = new Promise<{ status: string; pid: number | null }>((done) => { resolve = done; });
    return {
        pid,
        release: () => resolve({ status: over.onRelease ?? `ack=setup-complete pid=${pid}\n`, pid }),
        abort: () => resolve({
            status: over.onAbort ?? `ack=setup-complete pid=${pid}\nstage=release errno=0\n`, pid,
        }),
        settled,
    };
}

describe('helper status classification', () => {
    it('a bare EOF is not success — an ACK that never arrived is unknown', () => {
        expect(classifyHelperStatus({ status: '', pid: 4242 })).toEqual({ kind: 'unknown', detail: 'no-ack-no-stage' });
    });

    it('a setup refusal names its stage and means nothing ran', () => {
        expect(classifyHelperStatus({ status: 'stage=cgroup errno=2\n', pid: 4242 }))
            .toEqual({ kind: 'setup-refused', stage: 'cgroup' });
    });

    it('an ACK followed by an exec error is a failure, not a success', () => {
        // 준비는 끝났지만 execve 가 실패했다. ACK 만 보고 성공이라 하면 안 된다.
        expect(classifyHelperStatus({ status: 'ack=setup-complete\nstage=exec errno=2\n', pid: 4242 }))
            .toEqual({ kind: 'exec-failed', stage: 'exec' });
    });

    it('the pid comes from the helper’s own ACK, not from spawn alone', () => {
        expect(classifyHelperStatus({ status: 'ack=setup-complete pid=777\n', pid: 4242 }))
            .toEqual({ kind: 'exec-attempted', pid: 777 });
    });

    it('an ACK with no error record only means exec was attempted', () => {
        // helper 가 ACK 뒤 execve 전에 죽어도 여기까지는 같아 보인다.
        // workload 가 실제로 돌았다는 증거는 managed report 에서 온다.
        expect(classifyHelperStatus({ status: 'ack=setup-complete\n', pid: 4242 }))
            .toEqual({ kind: 'exec-attempted', pid: 4242 });
    });
});


/** 이 seam 이 낼 수 있는 실제 OS 오류. 코드가 판정을 가른다. */
function errno(code: string): NodeJS.ErrnoException {
    const error = new Error(code) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

describe('generation cgroup path', () => {
    it('is built from the delegated root and the generation identity', () => {
        expect(generationCgroupPath('/sys/fs/cgroup/saycode', KEY))
            .toBe('/sys/fs/cgroup/saycode/run-run-1/attempt-attempt-1/epoch-2');
    });

    it('refuses ids that would escape the delegated root', () => {
        for (const runId of ['../..', 'a/b', '']) {
            expect(() => generationCgroupPath('/sys/fs/cgroup/saycode', { ...KEY, runId }))
                .toThrow(/safe id/);
        }
        expect(() => generationCgroupPath('/sys/fs/cgroup/saycode', { ...KEY, epoch: -1 }))
            .toThrow(/epoch/);
    });
});

describe('supervisor', () => {
    let manifestRoot: string;
    let files: Map<string, string>;
    let dirs: Set<string>;

    function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            mkdir: (path) => { dirs.add(path); },
            writeFile: (path, data) => {
                const dir = path.replace(/\/[^/]+$/, '');
                if (!dirs.has(dir)) {
                    const error = new Error('ENOENT') as NodeJS.ErrnoException;
                    error.code = 'ENOENT';
                    throw error;
                }
                files.set(path, data);
            },
            readFile: (path) => {
                const value = files.get(path);
                if (value === undefined) throw new Error('missing');
                return value;
            },
            rmdir: (path) => {
                if (files.get(join(path, 'populated')) === 'yes') throw new Error('EBUSY');
                dirs.delete(path);
            },
            launch: async () => parkedHandle(4242),
            enrollWatchdog: () => {},
            ...over,
        };
    }

    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => {
        manifestRoot = mkdtempSync(join(tmpdir(), 'supervisor-manifest-'));
        files = new Map();
        dirs = new Set();
    });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function readyGeneration(d: SupervisorDeps) {
        const supervisor = createSupervisor(config, d);
        // 세대 cgroup 은 `prepareLaunch` 만 만든다. 여기서는 그 결과를 흉내낸다.
        const path = supervisor.generationCgroup(KEY);
        dirs.add(path);
        files.set(join(path, 'cgroup.events'), 'populated 1\nfrozen 0\n');
        return { supervisor, path };
    }

    it('passes only trusted values to the helper — the caller picks the generation, nothing else', async () => {
        const launch = vi.fn(async () => parkedHandle(4242));
        const d = deps({ launch });
        const { supervisor } = readyGeneration(d);
        await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE });
        expect(launch).toHaveBeenCalledWith(expect.objectContaining({
            helperPath: '/usr/local/lib/saycode/exec-helper',
            statusFd: 9,
            releaseFd: 8,
            inheritFds: [],
            env: {},
            argv: [
                '9', '8', '/sys/fs/cgroup/saycode/run-run-1/attempt-attempt-1/epoch-2',
                '10002', '10002', '0', '/usr/local/lib/saycode/node',
            ],
        }));
    });

    it('refuses to build a request that would keep the status fd', async () => {
        const launch = vi.fn(async () => parkedHandle(4242));
        const d = deps({ launch });
        const { supervisor } = readyGeneration(d);
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, inherit: [{ childFd: 3, parentFd: 3 }, { childFd: 9, parentFd: 9 }], leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 8, inherit: [{ childFd: 8, parentFd: 8 }], leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(await supervisor.execGeneration({ key: KEY, statusFd: 9, releaseFd: 9, leaseExpiresMonotonic: LEASE }))
            .toEqual({ kind: 'setup-refused', stage: 'args' });
        expect(launch).not.toHaveBeenCalled();
    });

    it('a kill request is not a stop — the cgroup must be observed empty', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'still-populated' });
        // 관측하지 못했으니 증거도 남지 않는다.
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: false });
        expect(files.get(join(path, 'cgroup.kill'))).toBe('1');
    });

    it('records termination only after the empty cgroup is removed', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: true, observedEmptyAt: NOW });
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: true });
    });

    it('an rmdir refusal keeps the generation unproven', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        files.set(join(path, 'populated'), 'yes');
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'rmdir-refused' });
        expect(d.manifest.proveStopped(KEY)).toMatchObject({ proven: false });
    });

    it('an absent generation is not a stop', () => {
        const supervisor = createSupervisor(config, deps());
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'generation-absent' });
    });

    it('a second stop of a generation it already proved empty converges on the record', () => {
        const d = deps();
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');

        const first = supervisor.stopGeneration(KEY);
        expect(first).toEqual({ stopped: true, observedEmptyAt: NOW });

        /*
         * The first stop removed the cgroup and recorded the proof. Answering
         * the retry with `generation-absent` would mean a caller holding that
         * generation never converges — and the runtime that will not release
         * its lock until everything is proven down never releases it.
         *
         * What answers is the record, not the absence.
         */
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: true, observedEmptyAt: NOW });
    });

    it('an absent generation it never proved stopped is still not a stop', () => {
        // Same ENOENT, no record: absence on its own is not evidence.
        const supervisor = createSupervisor(config, deps());
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'generation-absent' });
    });

    it('the watchdog does not act before the lease expires', () => {
        const d = deps({ monotonicNow: () => 1_000 });
        const { supervisor } = readyGeneration(d);
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 })).toBeNull();
    });

    it('the watchdog stops an expired generation without consulting the daemon', () => {
        const d = deps({ monotonicNow: () => 6_000 });
        const { supervisor, path } = readyGeneration(d);
        files.set(join(path, 'cgroup.events'), 'populated 0\nfrozen 0\n');
        // daemon 은 이 판정에 등장하지 않는다.
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ stopped: true, observedEmptyAt: NOW });
    });

    it('the watchdog uses the monotonic clock, not the wall clock', () => {
        const d = deps({ monotonicNow: () => 1_000, now: () => NOW + 10_000_000 });
        const { supervisor } = readyGeneration(d);
        // 벽시계가 크게 앞서 있어도 만료가 아니다.
        expect(supervisor.enforceLease({ key: KEY, leaseExpiresMonotonic: 5_000 })).toBeNull();
    });
});

describe('a launch refused before any helper ran', () => {
    let manifestRoot: string;

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'sup-refused-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    /** 실제 원장 + 실제 supervisor. 갈리는 것은 OS seam 뿐이다. */
    function refuse(over: Partial<SupervisorDeps>) {
        const manifest = createGenerationManifest(manifestRoot);
        const supervisor = createSupervisor(config, {
            manifest,
            monotonicNow: () => 1_000,
            now: () => NOW,
            mkdir: () => { throw errno('EACCES'); },
            writeFile: () => { throw errno('ENOENT'); },
            readFile: () => { throw errno('ENOENT'); },
            rmdir: () => {},
            launch: async () => { throw new Error('never reached'); },
            enrollWatchdog: () => {},
            ...over,
        });
        return { manifest, supervisor };
    }

    const prepare = (supervisor: ReturnType<typeof createSupervisor>) => supervisor.prepareLaunch({
        key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: 60_000,
    });

    it('settles the ledger when the generation is confirmed never to have existed', async () => {
        // 부모가 없어 mkdir 이 ENOENT 다. 그 자리에 세대가 있었을 수 없다.
        const { manifest, supervisor } = refuse({ mkdir: () => { throw errno('ENOENT'); } });
        expect(await prepare(supervisor)).toEqual({ kind: 'setup-refused', stage: 'cgroup-create-failed' });
        /*
         * 열린 채로 두면 epoch 승격과 공급자 checkpoint 가 **재시작 두 번까지**
         * 막힌다. 아무것도 돌지 않았음이 확인됐으므로 그 자리에서 닫는다.
         */
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: true });
        expect(manifest.listOpen().records).toEqual([]);
    });

    it('leaves the ledger open when the cgroup state is unreadable', async () => {
        // EACCES 는 "없다" 가 아니라 **모른다** 이다. 모르는 것을 통과시키지 않는다.
        const { manifest, supervisor } = refuse({
            mkdir: () => { throw errno('EACCES'); },
            readFile: () => { throw errno('EACCES'); },
        });
        expect(await prepare(supervisor)).toEqual({ kind: 'setup-refused', stage: 'cgroup-create-failed' });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: false });
        expect(manifest.listOpen().records).toHaveLength(1);
    });

    it('leaves the ledger open when a group is already there with something in it', async () => {
        // 남의 것이 살아 있다. 치웠다고 적으면 그 위에 새 writer 가 열린다.
        const { manifest, supervisor } = refuse({
            mkdir: () => { throw errno('EEXIST'); },
            readFile: () => 'populated 1\n',
        });
        expect(await prepare(supervisor)).toEqual({ kind: 'setup-refused', stage: 'cgroup-create-failed' });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: false });
    });

    it('settles when the helper never launched and the group it made is observed empty', async () => {
        const removed: string[] = [];
        const { manifest, supervisor } = refuse({
            mkdir: () => {},
            readFile: () => 'populated 0\n',
            rmdir: (path) => { removed.push(path); },
            launch: async () => { throw new Error('spawn failed'); },
        });
        expect(await prepare(supervisor)).toEqual({ kind: 'unknown', detail: 'launch-failed' });
        expect(removed).toEqual([generationCgroupPath(config.cgroupRoot, KEY)]);
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: true });
    });

    it('leaves the ledger open when the kernel will not let the empty group go', async () => {
        // rmdir 이 거부하면 커널은 아직 비었다고 보지 않는다. 그것이 판정이다.
        const { manifest, supervisor } = refuse({
            mkdir: () => {},
            readFile: () => 'populated 0\n',
            rmdir: () => { throw errno('EBUSY'); },
            launch: async () => { throw new Error('spawn failed'); },
        });
        expect(await prepare(supervisor)).toEqual({ kind: 'unknown', detail: 'launch-failed' });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: false });
    });
});

describe('the watchdog and a generation whose stop was requested but never observed', () => {
    let manifestRoot: string;

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'sup-pending-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    /** 세대가 원장에 열려 있고 cgroup 은 사라진 상태를 만든다. */
    function pendingSupervisor(over: Partial<SupervisorDeps> = {}) {
        const manifest = createGenerationManifest(manifestRoot);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        return createSupervisor({
            cgroupRoot: '/sys/fs/cgroup/saycode',
            helperPath: '/x', workloadPath: '/y',
            resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
        }, {
            manifest,
            monotonicNow: () => 9_000,
            now: () => NOW,
            mkdir: () => {},
            // cgroup 이 이미 없다 — kill 요청이 ENOENT 로 돌아온다.
            writeFile: () => { throw errno('ENOENT'); },
            readFile: () => { throw errno('ENOENT'); },
            rmdir: () => {},
            launch: async () => { throw new Error('unused'); },
            enrollWatchdog: () => {},
            ...over,
        });
    }

    it('resolves it in this process instead of waiting for a restart', () => {
        const supervisor = pendingSupervisor();
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        /*
         * 첫 tick 은 정지를 **요청**하고 cgroup 이 없음을 본다. 그 부재는 이
         * 요청 뒤의 것이므로 증거가 되며, 그 자리에서 마무리해야 한다. 예전에는
         * `generation-absent` 만 돌려주고 영원히 다시 시도했다.
         */
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: true });
        expect(watchdog.armedCount()).toBe(0);
    });

    it('keeps watching when the cgroup state cannot be read', () => {
        // 모르는 것은 통과가 아니다 — 감시를 놓으면 아무도 다시 시도하지 않는다.
        const supervisor = pendingSupervisor({ readFile: () => { throw errno('EACCES'); } });
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: false });
        expect(watchdog.armedCount()).toBe(1);
    });
});

describe('a launch that produced no helper at all', () => {
    let manifestRoot: string;

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'sup-nohelper-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    it('settles the ledger when the real spawn never produced a process', async () => {
        /*
         * **이 경로가 실제로 도는 경로다.** 기본 `launch` 는 spawn 이 실패해도
         * 예외를 던지지 않는다 — `error` 를 받아 settle 하고 `pid: null` 인
         * handle 로 **resolve** 한다. 그래서 예외 경로만 정산하면 흔한 실패
         * (helper 경로 오류/ENOENT)는 그대로 열린 기록을 남긴다.
         */
        const removed: string[] = [];
        const enrolled: unknown[] = [];
        const manifest = createGenerationManifest(manifestRoot);
        const supervisor = createSupervisor({
            cgroupRoot: join(manifestRoot, 'cgroup-seam'),
            helperPath: join(manifestRoot, 'nonexistent-helper'),
            workloadPath: process.execPath,
            resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
        }, {
            ...defaultSupervisorDeps,
            manifest,
            monotonicNow: () => 1_000,
            now: () => 2_000,
            mkdir: () => {},
            readFile: () => 'populated 0\n',
            writeFile: () => {},
            rmdir: (path) => { removed.push(path); },
            enrollWatchdog: (entry) => { enrolled.push(entry); },
        });
        const result = await supervisor.prepareLaunch({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: 60_000,
        });
        // 기동의 판정은 그대로여야 한다 — 정산은 원장의 일이다.
        expect(result).toEqual({ kind: 'unknown', detail: 'no-ack-no-stage' });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: true });
        expect(removed).toEqual([generationCgroupPath(join(manifestRoot, 'cgroup-seam'), KEY)]);
        // 아무것도 돌지 않았다. 감시할 것이 없다.
        expect(enrolled).toEqual([]);
    });

    it('keeps the ledger open and watches when a process existed but never acked', async () => {
        /*
         * 프로세스는 있었고 ACK 은 없었다. 그 helper 가 cgroup 에 들어갔는지
         * **모른다** — 치웠다고 적을 수 없다. 대신 감시에 올려, lease 가 끝나면
         * 이 프로세스 안에서 정지가 시도되게 한다.
         */
        const enrolled: Array<{ key: unknown }> = [];
        const manifest = createGenerationManifest(manifestRoot);
        const supervisor = createSupervisor({
            cgroupRoot: '/sys/fs/cgroup/saycode',
            helperPath: '/x', workloadPath: '/y',
            resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
        }, {
            manifest,
            monotonicNow: () => 1_000,
            now: () => 2_000,
            mkdir: () => {},
            readFile: () => 'populated 0\n',
            writeFile: () => {},
            rmdir: () => {},
            enrollWatchdog: (entry) => { enrolled.push(entry); },
            launch: async () => ({
                pid: null,
                release: () => {}, abort: () => {},
                // 프로세스는 존재했다 — spawn 은 성공했고 ACK 만 오지 않았다.
                settled: Promise.resolve({ status: '', pid: 4242 }),
            }) as never,
        });
        const result = await supervisor.prepareLaunch({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: 60_000,
        });
        expect(result).toEqual({ kind: 'unknown', detail: 'no-ack-no-stage' });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: false });
        expect(enrolled).toHaveLength(1);
    });

    it('still refuses to settle an unreadable group even with no process', async () => {
        const manifest = createGenerationManifest(manifestRoot);
        const supervisor = createSupervisor({
            cgroupRoot: '/sys/fs/cgroup/saycode',
            helperPath: '/x', workloadPath: '/y',
            resolveGenerationCredentials: () => ({ uid: 1, gid: 1 }),
        }, {
            manifest,
            monotonicNow: () => 1_000,
            now: () => 2_000,
            mkdir: () => {},
            // 상태를 읽지 못한다. 프로세스가 없었다는 것만으로 닫지 않는다.
            readFile: () => { throw errno('EACCES'); },
            writeFile: () => {},
            rmdir: () => {},
            enrollWatchdog: () => {},
            launch: async () => ({
                pid: null, release: () => {}, abort: () => {},
                settled: Promise.resolve({ status: '', pid: null }),
            }) as never,
        });
        await supervisor.prepareLaunch({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: 60_000,
        });
        expect(manifest.proveAllBelow(KEY.epoch + 1)).toMatchObject({ proven: false });
    });
});

describe('autonomous lease watchdog', () => {
    function fakeSupervisor(outcomes: Array<{ stopped: boolean; detail?: string }>) {
        const calls: unknown[] = [];
        let index = 0;
        return {
            calls,
            supervisor: {
                stopGeneration: (key: typeof KEY) => {
                    calls.push(key);
                    const next = outcomes[Math.min(index++, outcomes.length - 1)]!;
                    return next.stopped
                        ? { stopped: true as const, observedEmptyAt: NOW }
                        : { stopped: false as const, detail: next.detail ?? 'still-populated' };
                },
                /*
                 * 이 축의 대역이지 판정이 아니다. 이 그룹의 결과는 전부
                 * `still-populated` 라 watchdog 의 해소 분기로 들어가지 않는다 —
                 * 그 분기는 실제 supervisor 로 따로 본다.
                 */
                resolvePendingTermination: (key: typeof KEY) => {
                    calls.push(key);
                    return { stopped: false as const, detail: 'termination-pending' };
                },
            },
        };
    }

    it('does nothing before the lease expires', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 1_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        expect(watchdog.tick()).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('stops an expired generation without asking the daemon anything', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        const results = watchdog.tick();
        expect(results).toEqual([{ key: KEY, outcome: { stopped: true, observedEmptyAt: NOW } }]);
        expect(calls).toEqual([KEY]);
        expect(watchdog.armedCount()).toBe(0);
    });

    it('keeps watching a generation whose stop was requested but not observed', () => {
        const { supervisor } = fakeSupervisor([{ stopped: false }, { stopped: true }]);
        const watchdog = createLeaseWatchdog({ supervisor, monotonicNow: () => 9_000, intervalMs: 100 });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: false });
        // 요청만으로 감시를 놓으면 살아남은 세대가 다시는 집행되지 않는다.
        expect(watchdog.armedCount()).toBe(1);
        expect(watchdog.tick()[0]!.outcome).toMatchObject({ stopped: true });
        expect(watchdog.armedCount()).toBe(0);
    });

    it('runs on its own timer', () => {
        const { supervisor, calls } = fakeSupervisor([{ stopped: true }]);
        let handler: (() => void) | null = null;
        const watchdog = createLeaseWatchdog({
            supervisor,
            monotonicNow: () => 9_000,
            intervalMs: 50,
            setInterval: ((fn: () => void) => { handler = fn; return 1 as unknown as NodeJS.Timeout; }) as never,
            clearInterval: (() => { handler = null; }) as never,
        });
        watchdog.arm({ key: KEY, leaseExpiresMonotonic: 5_000 });
        watchdog.start();
        expect(handler).not.toBeNull();
        handler!();
        expect(calls).toEqual([KEY]);
        watchdog.stop();
    });
});

describe('launch handshake and lease renewal', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'handshake-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function base(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {},
            writeFile: () => {},
            readFile: () => 'populated 0\n',
            rmdir: () => {},
            launch: async () => parkedHandle(4242),
            ...over,
        };
    }

    it('registration runs after the pid is known and before the child is released', async () => {
        const order: string[] = [];
        const supervisor = createSupervisor(config, base({
            launch: async () => {
                order.push('pid-acquired');
                const handle = parkedHandle(4242);
                return { ...handle, release: () => { order.push('released'); handle.release(); } };
            },
        }));
        const outcome = await supervisor.execGeneration({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE,
            onAcquired: async (pid) => { order.push(`registered:${pid}`); },
        });
        // 등록이 release 보다 먼저다 — 빠른 workload 의 첫 보고가 등록을 앞지르지 못한다.
        expect(order).toEqual(['pid-acquired', 'registered:4242', 'released']);
        expect(outcome).toEqual({ kind: 'exec-attempted', pid: 4242 });
    });

    it('a registration failure is propagated, not hidden', async () => {
        const supervisor = createSupervisor(config, base({
            launch: async () => parkedHandle(4242),
        }));
        expect(await supervisor.execGeneration({
            key: KEY, statusFd: 9, releaseFd: 8, leaseExpiresMonotonic: LEASE,
            onAcquired: async () => { throw new Error('registry unavailable'); },
        })).toEqual({ kind: 'exec-failed', stage: 'release' });
    });

    it('refuses to renew a generation that was never launched', () => {
        expect(createSupervisor(config, base())
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'never-launched' });
    });

    it('refuses to renew a generation whose stop was already requested', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        deps.manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW });
        expect(createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'termination-pending' });
    });

    it('refuses a renewal whose deadline has already passed', () => {
        const deps = base({ monotonicNow: () => 9_000 });
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        expect(createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: false, detail: 'lease-already-expired' });
    });

    it('a renewal updates the watchdog deadline, not just the sequence', () => {
        const armed: unknown[] = [];
        const deps = base({ enrollWatchdog: (entry) => { armed.push(entry); } });
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        createSupervisor(config, deps)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 });
        expect(armed).toEqual([{ key: KEY, leaseExpiresMonotonic: 5_000 }]);
    });

    it('a renewal must advance the sequence', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toEqual({ renewed: true, leaseExpiresMonotonic: 5_000 });
        // 같은 토큰 재전송으로 deadline 을 늘리지 못한다.
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: false, detail: 'stale-renewal' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 0, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: false, detail: 'stale-renewal' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 2, leaseExpiresMonotonic: 9_000 }))
            .toEqual({ renewed: true, leaseExpiresMonotonic: 9_000 });
    });

    it('a different generation has its own sequence', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        deps.manifest.recordLaunch({ key: { ...KEY, epoch: 3 }, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        supervisor.renewLease({ key: KEY, renewalSeq: 5, leaseExpiresMonotonic: 5_000 });
        expect(supervisor.renewLease({ key: { ...KEY, epoch: 3 }, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toMatchObject({ renewed: true });
    });

    it('refuses renewals that are not usable numbers', () => {
        const deps = base();
        deps.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, deps);
        expect(supervisor.renewLease({ key: KEY, renewalSeq: -1, leaseExpiresMonotonic: 1 }))
            .toEqual({ renewed: false, detail: 'invalid-renewal-seq' });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: Number.NaN }))
            .toEqual({ renewed: false, detail: 'invalid-expiry' });
    });
});

describe('a cancelled generation is never released (Astra P1-1)', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/usr/local/lib/saycode/exec-helper',
        workloadPath: '/usr/local/lib/saycode/node',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'release-guard-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    function deps(over: Partial<SupervisorDeps> = {}): SupervisorDeps {
        return {
            manifest: createGenerationManifest(manifestRoot),
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {},
            writeFile: () => {},
            readFile: () => 'populated 1\n',
            rmdir: () => {},
            launch: async () => parkedHandle(4242),
            ...over,
        };
    }

    function tracked() {
        let releases = 0;
        let aborts = 0;
        const handle = parkedHandle(4242);
        return {
            get releases() { return releases; },
            get aborts() { return aborts; },
            handle: {
                ...handle,
                release: () => { releases += 1; handle.release(); },
                abort: () => { aborts += 1; handle.abort(); },
            },
        };
    }

    it('refuses to release a generation whose stop was requested while it was parked', async () => {
        // `requestStop` 은 의도를 남겼지만 kill 은 park 된 helper 를 죽이지
        // 못했다. 그대로 놓아주면 취소된 세대가 실행된다.
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        d.manifest.recordTerminationRequested({ key: KEY, requestedAt: NOW });
        const supervisor = createSupervisor(config, d);
        const probe = tracked();
        expect(await supervisor.releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'termination-pending' });
        expect(probe.releases).toBe(0);
        expect(probe.aborts).toBe(1);
    });

    it('refuses to release a generation already observed stopped', async () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        d.manifest.recordTermination({ key: KEY, observedEmptyAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'already-stopped' });
        expect(probe.releases).toBe(0);
    });

    it('refuses to release when the lease expired during preparation', async () => {
        const d = deps({ monotonicNow: () => 99_000 });
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'lease-already-expired' });
        expect(probe.releases).toBe(0);
    });

    it('refuses to release when the record cannot be read — unknown is not permission', async () => {
        // 거부 목록을 쓰면 이 상태가 목록에 없어 통과한다. 취소됐는지 모르는데
        // 놓아주는 것이 정확히 그 결함이었다.
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'setup-refused', stage: 'record-unreadable' });
        expect(probe.releases).toBe(0);
        expect(probe.aborts).toBe(1);
    });

    it('refuses to renew when the record cannot be read', () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        expect(createSupervisor(config, d)
            .renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 60_000 }))
            .toEqual({ renewed: false, detail: 'record-unreadable' });
    });

    it('a stop that could not record its intent does not become permission to release', async () => {
        // 원장을 쓰지 못해 정지 요청조차 남기지 못한 상태다.
        const d = deps({
            manifest: {
                ...createGenerationManifest(manifestRoot),
                recordTerminationRequested: () => { throw new Error('unwritable'); },
            },
        });
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, d);
        expect(supervisor.stopGeneration(KEY)).toEqual({ stopped: false, detail: 'manifest-unwritable' });
        // 정지에 실패했다고 해서 실행 권한이 생기지는 않는다.
        writeFileSync(join(manifestRoot, `${generationScopeDigest(KEY)}.json`), '{broken');
        const probe = tracked();
        expect(await supervisor.releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toMatchObject({ kind: 'setup-refused' });
        expect(probe.releases).toBe(0);
    });

    it('releases a live, uncancelled generation', async () => {
        const d = deps();
        d.manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const probe = tracked();
        expect(await createSupervisor(config, d).releaseLaunch({
            key: KEY, handle: probe.handle, leaseExpiresMonotonic: 60_000,
        })).toEqual({ kind: 'exec-attempted', pid: 4242 });
        expect(probe.releases).toBe(1);
    });
});

describe('an expired lease cannot be revived by a newer renewal (Astra P1-2)', () => {
    let manifestRoot: string;
    const config = {
        cgroupRoot: '/sys/fs/cgroup/saycode',
        helperPath: '/h',
        workloadPath: '/w',
        resolveGenerationCredentials: () => ({ uid: 10002, gid: 10002 }),
    };

    beforeEach(() => { manifestRoot = mkdtempSync(join(tmpdir(), 'renew-guard-')); });
    afterEach(() => { rmSync(manifestRoot, { recursive: true, force: true }); });

    it('stores the current deadline so a renewal actually moves it', () => {
        const armed: Array<{ leaseExpiresMonotonic: number }> = [];
        const manifest = createGenerationManifest(manifestRoot);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        const supervisor = createSupervisor(config, {
            manifest,
            monotonicNow: () => 1_000,
            now: () => NOW,
            enrollWatchdog: (entry) => { armed.push(entry); },
            mkdir: () => {}, writeFile: () => {}, readFile: () => 'populated 0\n', rmdir: () => {},
            launch: async () => parkedHandle(1),
        });
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 }))
            .toMatchObject({ renewed: true });
        expect(armed).toEqual([{ key: KEY, leaseExpiresMonotonic: 5_000 }]);
    });

    it('a renewal arriving after the stored deadline passed is refused and records stop intent', () => {
        const manifest = createGenerationManifest(manifestRoot);
        manifest.recordLaunch({ key: KEY, launchedAt: NOW });
        let clock = 1_000;
        const supervisor = createSupervisor(config, {
            manifest,
            monotonicNow: () => clock,
            now: () => NOW,
            enrollWatchdog: () => {},
            mkdir: () => {}, writeFile: () => {}, readFile: () => 'populated 0\n', rmdir: () => {},
            launch: async () => parkedHandle(1),
        });
        supervisor.renewLease({ key: KEY, renewalSeq: 1, leaseExpiresMonotonic: 5_000 });
        // watchdog tick 이 돌기 전에 만료됐고, 더 큰 seq 와 미래 deadline 이 온다.
        clock = 9_000;
        expect(supervisor.renewLease({ key: KEY, renewalSeq: 2, leaseExpiresMonotonic: 20_000 }))
            .toEqual({ renewed: false, detail: 'lease-expired' });
        // 그 tick 이 확실히 집행하도록 정지 의도가 남는다.
        expect(manifest.proveStopped(KEY)).toMatchObject({ detail: 'termination-pending' });
    });
});


it.runIf(process.platform === 'linux')('returns the exact bound physical address even when the alias changes after acquire', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ownership-address-'));
    const firstRoot = join(root, 'first'); const secondRoot = join(root, 'second'); const alias = join(root, 'alias');
    mkdirSync(firstRoot); mkdirSync(secondRoot); symlinkSync(firstRoot, alias);
    const input = { runtimeId: 'first', manifestRoot: alias, cgroupRoot: join(root, 'cgroup') };
    const expected = supervisorLockAddress(input);
    const held = await acquireSupervisorLock(input);
    expect(held.ok).toBe(true);
    if (!held.ok) throw new Error('fixture lock unavailable');
    try {
        unlinkSync(alias); symlinkSync(secondRoot, alias);
        expect(held.address).toBe(expected);
        expect(supervisorLockAddress(input)).not.toBe(held.address);
        expect(await acquireSupervisorLock({ ...input, runtimeId: 'another', manifestRoot: firstRoot }))
            .toEqual({ ok: false, reason: 'already-held' });
    } finally { await held.release(); rmSync(root, { recursive: true, force: true }); }
});
