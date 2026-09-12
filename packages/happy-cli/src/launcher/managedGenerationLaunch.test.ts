/**
 * The launcher's two-phase managed launch, driven by the real composition.
 *
 * `launchManagedRun` is the real one: only the provider supervisor and the tool
 * executor are stood in for, because those are the parts that need a
 * privileged helper. So what is observed here is what the product actually
 * does — a broker opened for this run, a per-generation provider script
 * written, the plan reaching the provider's environment — rather than
 * arguments echoed back by a mock.
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { createManagedGenerationLauncher } from './managedGenerationLaunch';
import { MANAGED_CODING_TOOLS } from './managedToolCatalogue';
import type { ExecutorProcess, ToolExecutorDeps } from './toolExecutor';
import { parseManagedSpawnEnvelope, type ManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';

const KEY = { runId: 'r', attemptId: 'a', epoch: 0 };

/**
 * The runtime was provisioned for one Happy. An envelope naming a different
 * one is not a configuration variant — it is a request to hand this run's
 * scoped token to a server the operator never provisioned.
 */
const TRUSTED_ORIGIN = 'https://provisioned.example.test';
const OTHER_ORIGIN = 'https://elsewhere.example.test';

const ENVELOPE = {
    directory: '/workspace/project',
    agent: 'claude',
    model: 'claude-sonnet-5',
    effort: 'medium',
    initialPrompt: 'do the thing',
    initialPromptLocalId: 'local-1',
    // Only the origin is real here; the rest of the bootstrap is not what
    // these cases are about. The origin is, because every prepare is now
    // checked against the runtime's own.
    bootstrap: { serverOrigin: TRUSTED_ORIGIN } as never,
    aiAuth: { kind: 'platform-gateway' },
    gateway: {} as never,
} as unknown as ManagedSpawnEnvelope;

function executorDeps(events: string[]): ToolExecutorDeps {
    return {
        helperPath: '/usr/local/lib/saycode/executor-helper',
        workloadPath: '/usr/local/lib/saycode/tool-workload',
        cgroupPath: '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
        spawn: (): ExecutorProcess => {
            events.push('tool-spawn');
            return {
                ack: Promise.resolve({ pid: 4242, status: 'ack=setup-complete pid=4242' }),
                release: () => undefined,
                abort: () => undefined,
                write: () => undefined,
                settled: Promise.resolve({ exitCode: 0, stdout: '', status: '' }),
            };
        },
        applyNetwork: async () => ({ ok: true, teardown: () => ({ cleaned: true, detail: 'clean' }) }),
        killCgroup: async () => ({ proven: true, detail: 'cgroup-empty' }),
        monotonicNow: () => 0,
    };
}

type SupervisorBehaviour = {
    /** Makes the provider plan unwritable, so the launch rejects after setup. */
    writeFails?: boolean;
    /** The launching instance's own lease answer. */
    renew?: (input: { key: unknown; renewalSeq: number; leaseExpiresMonotonic: number }) =>
        { renewed: true; leaseExpiresMonotonic: number } | { renewed: false; detail: string };
    /** What the accepted supervisor returns when the park is not aborted. */
    exec?: () => { kind: 'exec-attempted'; pid: number } | { kind: 'setup-refused'; stage: string };
    /** Whether a stop is ever observed as empty. */
    stop?: () => { stopped: true; observedEmptyAt: number } | { stopped: false; detail: string };
    /** Hands the run the child's real exit, the way the helper's watcher does. */
    exit?: { code: number | null; signal: string | null };
};

function launcher(
    events: string[],
    overrides: Record<string, unknown> = {},
    behaviour: SupervisorBehaviour = {},
) {
    let launchedEnv: Record<string, string> = {};
    const built: Record<string, unknown>[] = [];
    const written: string[] = [];
    const created = createManagedGenerationLauncher({
        identity: {
            isolation: {
                backend: 'fly-machines',
                provider: { uid: 10601, gid: 10601 },
                executor: { uid: 10602, gid: 10600 },
                cgroupRoot: '/sys/fs/cgroup/saycode',
            },
        } as never,
        serverOrigin: TRUSTED_ORIGIN,
        toolHelperPath: '/usr/local/lib/saycode/executor-helper',
        providerHelperPath: '/usr/local/lib/saycode/exec-helper',
        execPath: '/usr/local/bin/happy',
        tools: MANAGED_CODING_TOOLS,
        scope: ['read_file', 'write_file'],
        ttlMs: 60_000,
        toolTimeoutMs: 5_000,
        providerEnvironment: () => ({ PATH: '/usr/bin' }),
        onUnprovenTermination: (info: { tool: string; detail?: string }) => {
            events.push(`unproven:${info.tool}`);
        },
        cgroupPathFor: () => '/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0',
        executorDeps: executorDeps(events),
        monotonicNow: () => 0,
        writeFile: (file: { path: string }) => {
            if (behaviour.writeFails) throw new Error('cannot write the provider plan');
            written.push(file.path);
            events.push(`write:${file.path}`);
        },
        readProcEnviron: () => launchedEnv,
        lstatPath: (path: string) => (path === '/usr/local/bin/happy'
            ? { uid: 0, mode: 0o555, isDirectory: false, isSymbolicLink: false, isFile: true }
            : { uid: 0, mode: 0o755, isDirectory: true, isSymbolicLink: false, isFile: false }),
        createProviderSupervisor: (config: { envAllowlist: Record<string, string>; helperPath: string }) => {
            built.push(config as unknown as Record<string, unknown>);
            launchedEnv = config.envAllowlist;
            return {
                /*
                 * The real `execGeneration` catches a rejection from
                 * `onAcquired`, aborts the parked handle and returns a
                 * non-`exec-attempted` outcome — it does not release and it
                 * does not throw. A fixture that let the rejection escape
                 * would hide exactly the bug this file is about.
                 */
                execGeneration: async (call: {
                    onAcquired?: (pid: number) => Promise<void>;
                    onExit?: (exit: { code: number | null; signal: string | null }) => void;
                }) => {
                    events.push('park');
                    if (call.onAcquired) {
                        try {
                            await call.onAcquired(777);
                        } catch {
                            events.push('abort');
                            return { kind: 'setup-refused' as const, stage: 'register' };
                        }
                    }
                    events.push('release');
                    if (behaviour.exit && call.onExit) call.onExit(behaviour.exit);
                    return behaviour.exec
                        ? behaviour.exec()
                        : { kind: 'exec-attempted' as const, pid: 777 };
                },
                ...(behaviour.renew ? { renewLease: behaviour.renew } : {}),
                stopGeneration: () => {
                    events.push('stop-generation');
                    return behaviour.stop
                        ? behaviour.stop()
                        : { stopped: true as const, observedEmptyAt: 1 };
                },
            } as never;
        },
        ...overrides,
    } as never);
    return { launcher: created, built, written, env: () => launchedEnv };
}

const prepareInput = {
    key: KEY,
    envelope: ENVELOPE,
    leaseExpiresMonotonic: 10_000,
    statusFd: 9,
    releaseFd: 8,
};

describe('createManagedGenerationLauncher', () => {
    it('shouldParkTheGenerationAndWaitForRegistrationBeforeReleasing', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        const prepared = await created.prepare(prepareInput);

        expect(prepared).toMatchObject({ prepared: true, pid: 777 });
        // Parked, not released: the daemon has not registered yet.
        expect(events).toContain('park');
        expect(events).not.toContain('release');
        expect(created.parkedCount()).toBe(1);

        const released = await created.release((prepared as { handle: string }).handle);
        expect(released).toEqual({ released: true, detail: 'exec-attempted' });
        expect(events.indexOf('park')).toBeLessThan(events.indexOf('release'));
        expect(created.parkedCount()).toBe(0);
    });

    it('shouldGiveTheGenerationThisRunsPlanRatherThanAFixedWorkload', async () => {
        const events: string[] = [];
        const { launcher: created, built, written, env } = launcher(events);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        // A broker was opened for this run and its plan reached the provider's
        // environment — the runtime's fixed config carries neither.
        expect(built).toHaveLength(1);
        expect(Object.keys(env())).toContain('SAYCODE_PROVIDER_SDK_OPTIONS');
        // And the generation script is this generation's, not the image's tool
        // program.
        expect(written.some((path) => path.startsWith('/usr/local/lib/saycode/provider-exec-'))).toBe(true);
        expect(written).not.toContain('/usr/local/lib/saycode/tool-workload');
        expect((built[0] as { helperPath: string }).helperPath).toBe('/usr/local/lib/saycode/exec-helper');
    });

    it('shouldRefuseASecondReleaseOfTheSameHandle', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        const prepared = await created.prepare(prepareInput);
        const handle = (prepared as { handle: string }).handle;

        expect(await created.release(handle)).toMatchObject({ released: true });
        expect(await created.release(handle)).toEqual({ released: false, detail: 'unknown-handle' });
    });

    it('shouldReportAFailureThatHappensBeforeItEverParks', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events, {
            // The two uids are one: `launchManagedRun` refuses before opening
            // anything.
            identity: {
                isolation: {
                    backend: 'fly-machines',
                    provider: { uid: 10601, gid: 10601 },
                    executor: { uid: 10601, gid: 10601 },
                    cgroupRoot: '/sys/fs/cgroup/saycode',
                },
            },
        });

        const prepared = await created.prepare(prepareInput);

        expect(prepared).toMatchObject({ prepared: false });
        expect(created.parkedCount()).toBe(0);
        expect(events).not.toContain('park');
    });

    it('shouldNeverReleaseProviderExecutionWhenAParkedGenerationIsAbandoned', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        const folded = await created.abandon(prepared.handle);

        /*
         * Opening the gate *is* the release. Folding a parked generation by
         * opening it would launch the very run the deadline exists to prevent,
         * so the gate is rejected and the park aborted.
         */
        expect(events).not.toContain('release');
        expect(events).toContain('abort');
        expect(created.parkedCount()).toBe(0);
        // And the broker is not left listening on a gate nobody will open.
        expect(folded).toMatchObject({ released: false, terminated: true });
        expect(created.liveHandles()).toEqual([]);
        expect(await created.release(prepared.handle))
            .toEqual({ released: false, detail: 'unknown-handle' });
    });

    it('shouldReportAnAbandonedGenerationAsUnterminatedWhenTheStopIsNotObserved', async () => {
        const events: string[] = [];
        // Told to stop, never observed empty. Retried, still not.
        const { launcher: created } = launcher(events, {}, {
            stop: () => ({ stopped: false, detail: 'not-observed-empty' }),
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        const folded = await created.abandon(prepared.handle);

        expect(folded.terminated).toBe(false);
        // Silence here would leave a live generation looking finished.
        expect(events).toContain('unproven:generation');
        expect(events).not.toContain('release');
    });

    it('shouldNotReportASetupRefusedRunAsReleased', async () => {
        const events: string[] = [];
        // The accepted supervisor returns this normally — nothing ran.
        const { launcher: created } = launcher(events, {}, {
            exec: () => ({ kind: 'setup-refused', stage: 'cgroup' }),
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        const released = await created.release(prepared.handle);

        expect(released).toEqual({ released: false, detail: 'setup-refused' });
        // Nothing ran, so nothing is owned and nothing is left listening.
        expect(created.liveHandles()).toEqual([]);
    });

    it('shouldKeepTheReleasedGenerationSoAStopCanTakeItDownWithProof', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        expect(await created.release(prepared.handle)).toEqual({ released: true, detail: 'exec-attempted' });
        // The broker and the generation outlive the release; whoever holds
        // them is the only one who can take them down.
        expect(created.liveHandles()).toEqual([prepared.handle]);
        expect(created.handleForKey(KEY)).toBe(prepared.handle);

        expect(await created.close(prepared.handle)).toEqual({ proven: true, detail: 'observed-empty' });
        expect(events).toContain('stop-generation');
        expect(created.liveHandles()).toEqual([]);
        expect(await created.close(prepared.handle)).toEqual({ proven: false, detail: 'unknown-handle' });
    });

    it('shouldKeepOwnershipOfAGenerationWhoseCloseCouldNotBeProven', async () => {
        const events: string[] = [];
        let canStop = false;
        const { launcher: created } = launcher(events, {}, {
            stop: () => (canStop
                ? { stopped: true, observedEmptyAt: 1 }
                : { stopped: false, detail: 'not-empty' }),
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');
        await created.release(prepared.handle);

        expect((await created.close(prepared.handle)).proven).toBe(false);
        /*
         * Giving the handle up here would leave a possibly-live generation
         * that no later close can reach — and would let a shutdown read the
         * empty map as "nothing left to take down".
         */
        expect(created.liveHandles()).toEqual([prepared.handle]);

        canStop = true;
        expect(await created.closeAll())
            .toEqual([{ handle: prepared.handle, proven: true, detail: 'observed-empty' }]);
        expect(created.liveHandles()).toEqual([]);
    });

    it('shouldKeepOwnershipOfAFoldedGenerationThatWasNeverProvenEmpty', async () => {
        const events: string[] = [];
        let canStop = false;
        const { launcher: created } = launcher(events, {}, {
            stop: () => (canStop
                ? { stopped: true, observedEmptyAt: 1 }
                : { stopped: false, detail: 'not-empty' }),
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        expect((await created.abandon(prepared.handle)).terminated).toBe(false);
        // An unproven fold is still this launcher's to finish.
        expect(created.liveHandles()).toEqual([prepared.handle]);

        canStop = true;
        expect((await created.close(prepared.handle)).proven).toBe(true);
        expect(created.liveHandles()).toEqual([]);
    });

    it('shouldRenewAgainstTheSupervisorThatActuallyLaunchedTheGeneration', async () => {
        const events: string[] = [];
        const renewals: unknown[] = [];
        const { launcher: created } = launcher(events, {}, {
            renew: (input) => {
                renewals.push(input);
                // 이 인스턴스만 이 세대의 deadline 을 들고 있다.
                return { renewed: false, detail: 'lease-expired' };
            },
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');

        const renewed = created.renewGeneration({
            key: KEY, renewalSeq: 4, leaseExpiresMonotonic: 999_999,
        });

        /*
         * A different supervisor instance holds no deadline for this key, and
         * "no deadline" reads as "nothing to refuse" — which is how an expired
         * generation gets resurrected. The launching instance refuses.
         */
        expect(renewed).toEqual({ renewed: false, detail: 'lease-expired' });
        expect(renewals).toEqual([{ key: KEY, renewalSeq: 4, leaseExpiresMonotonic: 999_999 }]);
    });

    it('shouldSayItIsNotTheAuthorityRatherThanApprovingAnUnknownGeneration', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        expect(created.renewGeneration({
            key: { runId: 'other', attemptId: 'a', epoch: 0 },
            renewalSeq: 1,
            leaseExpiresMonotonic: 999_999,
        })).toEqual({ renewed: false, detail: 'no-generation-authority' });
    });

    it('shouldRetainAnUnprovenGenerationWhenTheLaunchItselfRejects', async () => {
        const events: string[] = [];
        let canStop = false;
        const { launcher: created } = launcher(events, {}, {
            // The provider plan cannot be written, so the launch throws with
            // typed stop evidence rather than parking.
            writeFails: true,
            stop: () => (canStop
                ? { stopped: true, observedEmptyAt: 1 }
                : { stopped: false, detail: 'not-empty' }),
        });

        const prepared = await created.prepare(prepareInput);

        expect(prepared).toMatchObject({ prepared: false });
        /*
         * An ordinary `prepare` failure just returns, so retaining only inside
         * `abandon` would drop a generation whose stop was never observed —
         * with nothing left for `closeAll` to retry.
         */
        expect(created.liveHandles()).toHaveLength(1);

        canStop = true;
        const closed = await created.closeAll();
        expect(closed).toHaveLength(1);
        expect(closed[0]!.proven).toBe(true);
        expect(created.liveHandles()).toEqual([]);
    });

    it('shouldReportEveryOwnedGenerationWithItsOwnProofUntilAllAreProven', async () => {
        const events: string[] = [];
        let canStop = false;
        const { launcher: created } = launcher(events, {}, {
            stop: () => (canStop
                ? { stopped: true, observedEmptyAt: 1 }
                : { stopped: false, detail: 'not-empty' }),
        });
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');
        await created.release(prepared.handle);

        // One unproven row is enough for the runtime's shutdown to hold the
        // lock: releasing on this answer leaves a live child unwatched.
        expect(await created.closeAll())
            .toEqual([{ handle: prepared.handle, proven: false, detail: 'not-empty' }]);
        expect(created.liveHandles()).toEqual([prepared.handle]);

        canStop = true;
        expect(await created.closeAll())
            .toEqual([{ handle: prepared.handle, proven: true, detail: 'observed-empty' }]);
        // Nothing owned is nothing left to prove.
        expect(await created.closeAll()).toEqual([]);
    });

    it('shouldCloseEveryOwnedGenerationOnShutdown', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        const prepared = await created.prepare(prepareInput);
        if (!prepared.prepared) throw new Error('prepare failed');
        await created.release(prepared.handle);

        const closed = await created.closeAll();

        expect(closed).toEqual([{ handle: prepared.handle, proven: true, detail: 'observed-empty' }]);
        expect(created.liveHandles()).toEqual([]);
    });
});

describe('the generation key stays separated, and the source stays greppable', () => {
    /**
     * The separator between a key's fields is NUL, because a run id, attempt id
     * and epoch cannot contain one — so no two different keys can collide by
     * running their fields together.
     *
     * It has to be written as the **escape**, not as a raw NUL byte in the
     * source. A raw one makes the file binary as far as `file(1)` and BSD
     * `grep` are concerned, and BSD grep then reports *no matches for the whole
     * file* rather than an error. In a repository several people review by
     * grepping, that reads as "this code does not exist".
     */
    it('shouldContainNoRawNulBytesInTheSource', async () => {
        const source = await readFile(new URL('./managedGenerationLaunch.ts', import.meta.url));
        expect(source.includes(0x00)).toBe(false);
    });

    it('shouldStillSeparateTheKeyFieldsWithANulSoNeighbouringKeysCannotCollide', () => {
        // The separator is what keeps these two apart: without it both would
        // render as the same string and one generation's entry would answer for
        // the other's.
        const left = { runId: 'a', attemptId: 'bc', epoch: 1 };
        const right = { runId: 'ab', attemptId: 'c', epoch: 1 };
        const render = (key: typeof left) => `${key.runId}\x00${key.attemptId}\x00${key.epoch}`;
        expect(render(left)).not.toBe(render(right));
        expect(render(left)).toContain('\x00');
    });
});

describe('the provider lifecycle a checkpoint has to ask about', () => {
    /*
     * `proveProviderQuiescence` refuses with `exit-unobserved` unless something
     * saw the child leave, and with `provider-restarted` if a provider started
     * during the proof. `managedProviderRun` already watches the exit and this
     * launcher already knows every generation it exec'd — but until now it
     * dropped both on the floor at `live.set`, so the only production place
     * that could answer had nothing to answer with.
     */
    it('shouldReportTheExitTheHelperActuallyObservedForAReleasedGeneration', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events, {}, { exit: { code: 0, signal: null } });

        const prepared = await created.prepare(prepareInput);
        const handle = (prepared as { handle: string }).handle;
        expect(created.observedProviderExit(handle)).toBeNull();

        await created.release(handle);
        expect(created.observedProviderExit(handle)).toEqual({ code: 0, signal: null });
    });

    it('shouldSayNothingWasObservedWhenTheChildWasNotSeenToLeave', async () => {
        // `null` is "not seen", which is not the same as "left cleanly" — the
        // gate turns the first into `exit-unobserved` and must not be handed a
        // manufactured zero.
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);
        expect(created.observedProviderExit((prepared as { handle: string }).handle)).toBeNull();
    });

    it('shouldCountOnlyGenerationsThatActuallyExecdAsProviderStarts', async () => {
        const events: string[] = [];
        // A generation refused at setup ran nothing. Counting it would make a
        // proof look invalidated by a provider that never existed.
        const { launcher: created } = launcher(events, {}, {
            exec: () => ({ kind: 'setup-refused' as const, stage: 'register' }),
        });
        expect(created.providerStarts()).toBe(0);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);
        expect(created.providerStarts()).toBe(0);
    });

    it('shouldCountEachExecdGenerationOnce', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);
        expect(created.providerStarts()).toBe(1);
        // Asked twice, still one: a counter that moved when it was read would
        // invalidate every proof that spans two reads.
        expect(created.providerStarts()).toBe(1);
    });
});

/**
 * A real envelope, through the real parser — not a cast.
 *
 * The refusal has to land before the launch, not inside it: by the time an FD
 * is inherited or a generation is parked, the bootstrap document carrying the
 * scoped token already exists.
 */
function validEnvelope(origin: string): ManagedSpawnEnvelope {
    return parseManagedSpawnEnvelope({
        directory: '/workspace/project',
        agent: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: origin,
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: {
            baseUrl: 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages',
            provider: 'anthropic',
            endpoint: 'anthropic-messages',
            capability: 'cap-1',
            model: 'claude-opus-5',
        },
    }, Date.now());
}

describe('asking whether anything is still alive in a generation', () => {
    /*
     * Non-destructive on purpose. `stop()` proves emptiness by killing the
     * cgroup, which is the opposite of what a checkpoint wants to know before
     * it archives provider state.
     */
    function withEvents(events: (path: string) => string) {
        const seen: string[] = [];
        const { launcher: created } = launcher([], {
            readCgroupEvents: (path: string) => { seen.push(path); return events(path); },
        }, { exit: { code: 0, signal: null } });
        return { created, seen };
    }

    it('shouldReportNoWritersWhenEveryLiveGenerationsCgroupIsEmpty', async () => {
        const { created, seen } = withEvents(() => 'populated 0\n');
        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        expect(await created.writersRemaining()).toBe(0);
        // It actually looked, at the generation's own cgroup.
        expect(seen).toEqual(['/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-0']);
    });

    it('shouldReportAWriterWhileTheGenerationsCgroupIsStillPopulated', async () => {
        const { created } = withEvents(() => 'populated 1\n');
        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        expect(await created.writersRemaining()).toBe(1);
    });

    it('shouldTreatACgroupThatIsGoneAsHavingNoWriters', async () => {
        // ENOENT is the kernel saying the cgroup was removed, and it is only
        // removable once empty. That is an observation, not an absence of one.
        const { created } = withEvents(() => {
            const error = new Error('no such file') as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
        });
        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        expect(await created.writersRemaining()).toBe(0);
    });

    it('shouldCountAnUnreadableCgroupAsAWriterRatherThanAsQuiet', async () => {
        // The alternative is reporting quiet nobody observed. A checkpoint
        // that archives on the strength of a failed read archives a directory
        // something may still be writing.
        const { created } = withEvents(() => { throw new Error('EACCES'); });
        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        expect(await created.writersRemaining()).toBe(1);
    });
});

describe('closing admission against a provider that is already on its way', () => {
    /*
     * `providerStarts` moves when the launch promise settles, which is after
     * `prepare` returned. So a proof taken between a `prepare` and its
     * `release` sees a count that has not moved yet and a generation that is
     * about to exist. Closing admission has to cover that window, not only the
     * exec.
     */
    it('shouldReportAPreparedButUnreleasedGenerationAsInFlight', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        await created.prepare(prepareInput);
        expect(created.closeLaunchAdmission()).toEqual({ closed: true, inFlight: 1 });
    });

    it('shouldReportNothingInFlightWhenNoGenerationIsPending', async () => {
        // Positive control: an idle launcher closes with nothing outstanding,
        // otherwise the case above would pass on a constant.
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        expect(created.closeLaunchAdmission()).toEqual({ closed: true, inFlight: 0 });
    });

    it('shouldRefuseANewGenerationWhileAdmissionIsClosed', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        created.closeLaunchAdmission();
        expect(await created.prepare(prepareInput))
            .toEqual({ prepared: false, detail: 'launch-admission-closed' });
        // Nothing was parked and nothing ran.
        expect(events).toEqual([]);
        expect(created.parkedCount()).toBe(0);
    });

    it('shouldAdmitAgainOnceAdmissionIsReopened', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        created.closeLaunchAdmission();
        created.reopenLaunchAdmission();

        expect(await created.prepare(prepareInput)).toMatchObject({ prepared: true });
    });

    it('shouldStopCountingAGenerationOnceItsLaunchHasSettled', async () => {
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);
        // Released and settled: it is a start now, not an in-flight launch.
        expect(created.closeLaunchAdmission().inFlight).toBe(0);
        expect(created.providerStarts()).toBe(1);
    });
});

describe('what the launcher can still answer after a generation goes wrong', () => {
    it('shouldKeepTheObservedExitWhenTheCloseCouldNotBeProven', async () => {
        /*
         * A close that fails keeps the generation owned so a later call can
         * retry it. The observation has to survive that, because it is the
         * only record that the provider left cleanly — losing it turns a
         * retryable cleanup into a checkpoint that can never be proven.
         */
        const events: string[] = [];
        const { launcher: created } = launcher(events, {}, {
            exit: { code: 0, signal: null },
            stop: () => ({ stopped: false as const, detail: 'cgroup-populated' }),
        });

        const prepared = await created.prepare(prepareInput);
        const handle = (prepared as { handle: string }).handle;
        await created.release(handle);
        expect(created.observedProviderExit(handle)).toEqual({ code: 0, signal: null });

        const closed = await created.close(handle);
        expect(closed.proven).toBe(false);
        // Still owned, and still able to say what was seen.
        expect(created.liveHandles()).toContain(handle);
        expect(created.observedProviderExit(handle)).toEqual({ code: 0, signal: null });
    });

    it('shouldCountAGenerationItCannotObserveAnExitFor', async () => {
        /*
         * A generation kept alive by a failed launch has no run to ask. It is
         * not "no exit yet" — nothing here will ever be able to answer for it,
         * and a checkpoint that archives provider state must refuse rather
         * than read that silence as quiet.
         */
        const events: string[] = [];
        const { launcher: created } = launcher(events, {}, {
            exec: () => ({ kind: 'setup-refused' as const, stage: 'register' }),
            stop: () => ({ stopped: false as const, detail: 'cgroup-populated' }),
        });
        expect(created.unobservableGenerations()).toBe(0);

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);

        expect(created.liveHandles().length).toBe(1);
        expect(created.unobservableGenerations()).toBe(1);
    });

    it('shouldNotCountAGenerationWhoseExitItCanObserve', async () => {
        // Positive control: a live generation the launcher launched itself is
        // answerable, however the close went.
        const events: string[] = [];
        const { launcher: created } = launcher(events, {}, {
            exit: { code: 0, signal: null },
            stop: () => ({ stopped: false as const, detail: 'cgroup-populated' }),
        });

        const prepared = await created.prepare(prepareInput);
        await created.release((prepared as { handle: string }).handle);
        await created.close((prepared as { handle: string }).handle);

        expect(created.liveHandles().length).toBe(1);
        expect(created.unobservableGenerations()).toBe(0);
    });
});

describe('an envelope may only name the Happy this runtime was provisioned for', () => {
    /** Counts every call the launch would make, so "0 calls" is checkable. */
    function launcherWithSpy(origin: string) {
        const events: string[] = [];
        const calls: unknown[] = [];
        const { launcher: created } = launcher(events, {
            serverOrigin: TRUSTED_ORIGIN,
            /*
             * Records and then never settles. A spy that threw would make the
             * positive control fail for its own reason and hide whether the
             * gate let it through, which is the only thing being asked.
             */
            launch: (arg: unknown) => { calls.push(arg); return new Promise(() => undefined); },
        });
        return { created, calls, events, envelope: validEnvelope(origin) };
    }

    it('shouldPrepareAnEnvelopeNamingTheProvisionedServer', async () => {
        /*
         * Positive control, through the real launch: the same valid envelope
         * differing in the one axis must park normally. Without it, the
         * refusal below would also pass a gate that refused everything.
         */
        const events: string[] = [];
        const { launcher: created } = launcher(events);

        const prepared = await created.prepare({
            ...prepareInput,
            envelope: validEnvelope(TRUSTED_ORIGIN),
        });

        expect(prepared).toMatchObject({ prepared: true, pid: 777 });
        expect(events).toContain('park');
        expect(created.parkedCount()).toBe(1);
    });

    it('shouldRefuseAnEnvelopeNamingAnotherServerWithoutLaunchingAnything', async () => {
        const { created, calls, events, envelope } = launcherWithSpy(OTHER_ORIGIN);

        expect(await created.prepare({ ...prepareInput, envelope }))
            .toEqual({ prepared: false, detail: 'envelope-origin-untrusted' });
        // Nothing was reached: no FD inherited, no bootstrap written, no park.
        expect(calls.length).toBe(0);
        expect(events).toEqual([]);
        expect(created.parkedCount()).toBe(0);
    });

    it('shouldNameOnlyTheAxisAndNeverEitherOrigin', async () => {
        // The refusal is read by the parent and logged. Neither origin is the
        // daemon's to echo back, and the token lives beside them.
        const { created, envelope } = launcherWithSpy(OTHER_ORIGIN);
        const refused = await created.prepare({ ...prepareInput, envelope }) as { detail: string };
        expect(refused.detail).not.toContain('example.test');
        expect(refused.detail).not.toContain('scoped.bearer.value');
    });
});

describe('what a live generation carries out of the launcher', () => {
    it('shouldGiveEachLiveGenerationItsOwnKeyNotAPositionInAnotherList', async () => {
        /*
         * `liveGenerations()` and `ownedGenerationKeys()` are two different
         * populations. A generation this launcher owns but cannot speak to —
         * one whose launch failed with the generation still up — is in the
         * owned list and **not** in the live list, so the two differ in length
         * and in order exactly when something has gone wrong.
         *
         * A consumer that paired them by position would attach one
         * generation's terminal answer to another generation's identity, which
         * is the reverse lookup the signed inventory must never have to do. So
         * each live entry carries its own key.
         */
        const events: string[] = [];
        const { launcher: created } = launcher(events);
        const live = { runId: 'run-live', attemptId: 'attempt-live', epoch: 3 };

        const prepared = await created.prepare({ ...prepareInput, key: live });
        await created.release((prepared as { handle: string }).handle);

        const generations = created.liveGenerations();
        expect(generations).toHaveLength(1);
        expect(generations[0]!.key).toEqual(live);
        // The handle is the launcher's own, and distinct from the key.
        expect(typeof generations[0]!.handle).toBe('string');
        expect(created.ownedGenerationKeys()).toContainEqual(live);
    });
});
