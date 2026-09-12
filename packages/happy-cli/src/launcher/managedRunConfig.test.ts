/**
 * The runtime's launch configuration: every value an isolation decision, and
 * none of them invented here.
 */
import { describe, expect, it } from 'vitest';

import {
    assertManagedRunPolicy,
    boundedGrantTtlMs,
    defaultManagedRunConfig,
    managedProviderEnvironment,
    MANAGED_GENERATION_CODEX_HOME,
    readManagedImageVersion,
    MANAGED_PROVIDER_HELPER_PATH,
    MANAGED_IMAGE_VERSION_FILE,
    MANAGED_TOOL_HELPER_PATH,
} from './managedRunConfig';
import {
    MANAGED_BOOTSTRAP_CHILD_FD,
    MANAGED_BOOTSTRAP_FD_ENV,
} from '@/managed/managedSpawnBootstrap';
import {
    MANAGED_REPORT_CHILD_FD,
    MANAGED_REPORT_FD_ENV,
} from '@/daemon/launch/managedReportCredential';
import {
    MANAGED_IMAGE_VERSION_PATH,
    MANAGED_PROVIDER_EXEC_PATH,
    MANAGED_TOOL_WORKLOAD_PATH,
} from '@/managed/managedImagePackaging';
import { TRUSTED_PROVIDER_EXEC_PATH, TRUSTED_TOOL_WORKLOAD_PATH } from './managedProviderRun';
import { MANAGED_CODING_TOOLS } from './managedToolCatalogue';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { managedCheckpointAreas } from '@/managed/checkpoint/managedCheckpointSession';
import { parseManagedSpawnEnvelope } from '@/managed/managedSpawnBootstrap';
import { MANAGED_PROJECT_ROOT } from '@/daemon/managedRuntimeIdentity';
import type { ManagedRuntimeIdentity } from '@/daemon/managedRuntimeIdentity';

const POLICY = { ttlMs: 60_000, toolTimeoutMs: 5_000 };
/**
 * What the stored daemon credential says; the boot refuses without one.
 *
 * Deliberately *not* the envelope's own `bootstrap.serverOrigin` — if the two
 * were the same string, a mapping that read the envelope instead of the stored
 * credential would pass every assertion below.
 */
const SERVER_ORIGIN = 'https://provisioned.example.test';

function checkpointConfig(over: Record<string, unknown> = {}) {
    return {
        tenant: { tenantId: 'co-1', projectId: 'proj-1' },
        volume: () => ({ volumeId: 'vol-1', deviceUuid: 'uuid-1' }),
        image: { imageVersion: 'img-1' },
        areas: managedCheckpointAreas({
            projectRoot: MANAGED_PROJECT_ROOT,
            providerStateRoot: MANAGED_GENERATION_CODEX_HOME,
        }),
        drainBudgetMs: 30_000,
        flushDeps: { run: async () => ({ code: 0, stdout: '0|0|0' }) },
        targets: { next: async () => null },
        policy: null,
        ...over,
    } as never;
}

function composition(over: Record<string, unknown> = {}) {
    return defaultManagedRunConfig({
        identity: identity(), policy: POLICY, onUnprovenTermination: () => undefined,
        serverOrigin: SERVER_ORIGIN, checkpoint: checkpointConfig(), ...over,
    } as never);
}

function identity(): ManagedRuntimeIdentity {
    return {
        isolation: {
            backend: 'fly-machines',
            provider: { uid: 10601, gid: 10601 },
            executor: { uid: 10602, gid: 10600 },
            cgroupRoot: '/sys/fs/cgroup/saycode',
        },
    } as unknown as ManagedRuntimeIdentity;
}

function envelope(agent: 'claude' | 'codex') {
    const model = agent === 'claude' ? 'claude-opus-5' : 'gpt-5';
    const route = agent === 'claude'
        ? {
            baseUrl: 'https://studio.example.test/api/cloud/gateway/anthropic/v1/messages',
            provider: 'anthropic',
            endpoint: 'anthropic-messages',
        }
        : {
            baseUrl: 'https://studio.example.test/api/cloud/gateway/openai/v1/responses',
            provider: 'openai',
            endpoint: 'openai-responses',
        };
    return parseManagedSpawnEnvelope({
        directory: MANAGED_PROJECT_ROOT,
        agent,
        model,
        effort: 'high',
        initialPrompt: 'do the thing',
        initialPromptLocalId: 'a'.repeat(32),
        bootstrap: {
            version: 1,
            serverOrigin: 'https://happy.example.test',
            sessionId: 'sess-1',
            encryptionVariant: 'dataKey',
            rawKeyBase64: Buffer.alloc(32, 7).toString('base64'),
            wrappedKeyBase64: Buffer.alloc(105, 9).toString('base64'),
            scopedToken: 'scoped.bearer.value',
            tokenExpiresAt: Date.now() + 3_600_000,
        },
        gateway: { ...route, capability: 'cap-1', model },
    }, Date.now());
}

describe('defaultManagedRunConfig', () => {
    it('shouldGiveTheProviderAndTheToolTheirOwnHelperAndTheirOwnProgram', () => {
        const config = composition().managedRun;
        /*
         * `executorHelper` enters a per-call PID/mount/network namespace;
         * `execHelper` enters none. Handing either one the other's job changes
         * what the agent is isolated from without saying so.
         */
        expect(config.toolHelperPath).toBe(MANAGED_TOOL_HELPER_PATH);
        expect(config.providerHelperPath).toBe(MANAGED_PROVIDER_HELPER_PATH);
        expect(config.toolHelperPath).not.toBe(config.providerHelperPath);
        // And the generation's program is not the image's tool workload.
        expect(config.execPath).toBe(TRUSTED_PROVIDER_EXEC_PATH);
        expect(config.execPath).not.toBe(TRUSTED_TOOL_WORKLOAD_PATH);
    });

    it('shouldScopeTheGrantToThePermittedListRatherThanARequest', () => {
        const config = composition().managedRun;
        expect(config.scope).toEqual(MANAGED_CODING_TOOLS.map((tool) => tool.name));
        expect(config.tools).toBe(MANAGED_CODING_TOOLS);
    });

    it('shouldPutTheGenerationInItsOwnCgroupUnderTheMarkersRoot', () => {
        const config = composition().managedRun;
        expect(config.cgroupPathFor({ runId: 'r', attemptId: 'a', epoch: 2 }))
            .toBe('/sys/fs/cgroup/saycode/run-r/attempt-a/epoch-2');
    });

    it('shouldRefuseToBuildAConfigWithoutValidatedExecutionPolicy', () => {
        for (const policy of [{ ttlMs: 0, toolTimeoutMs: 1 }, { ttlMs: 1, toolTimeoutMs: -1 }]) {
            expect(() => composition({ policy })).toThrow(/managed run policy/);
        }
        // A missing value is refused, never replaced with one from here.
        expect(() => assertManagedRunPolicy({ ttlMs: Number.NaN, toolTimeoutMs: 5 })).toThrow();
    });
});

describe('managedProviderEnvironment', () => {
    it('shouldRouteClaudeThroughTheApprovedGatewayAndNoOtherCredential', () => {
        const env = managedProviderEnvironment(envelope('claude'));
        expect(env.ANTHROPIC_BASE_URL).toBe('https://studio.example.test/api/cloud/gateway/anthropic');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBe('cap-1');
        // The openai axis is not set for a claude run.
        expect(env.OPENAI_API_KEY).toBeUndefined();
    });

    it('shouldRouteCodexThroughItsOwnApprovedRoute', () => {
        const env = managedProviderEnvironment(envelope('codex'));
        expect(env.OPENAI_BASE_URL).toBe('https://studio.example.test/api/cloud/gateway/openai/v1');
        expect(env.OPENAI_API_KEY).toBe('cap-1');
        expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    });

    it('shouldCarryTheConfirmedPromptDeliveryFlagThatTheOrdinarySpawnPathWouldHaveSet', () => {
        /*
         * A managed generation never goes through `spawnSession`, so
         * `applyConfirmedPromptDeliveryFlag` never runs for it. Without the
         * flag on this channel the child delivers its first turn unconfirmed
         * and nothing reports that it did.
         */
        expect(managedProviderEnvironment(envelope('claude')).HAPPY_MANAGED_REQUIRE_PROMPT_ACK)
            .toBe('1');
    });

    it('shouldNotCarryTheSessionKeyOrTheScopedBearer', () => {
        const text = JSON.stringify(managedProviderEnvironment(envelope('claude')));
        expect(text).not.toContain('scoped.bearer.value');
        expect(text).not.toContain(Buffer.alloc(32, 7).toString('base64'));
    });
});

describe('the descriptors the child discovers managed mode by', () => {
    it('shouldNameTheBootstrapDescriptorTheLauncherActuallyBinds', () => {
        /*
         * `readManagedStartup` turns managed mode on by the presence of this
         * variable and nothing else. Without it the child never looks at the
         * inherited descriptor, attaches to no session, and comes up as an
         * ordinary unmanaged spawn holding a managed run's volume.
         */
        const env = managedProviderEnvironment(envelope('claude'));
        expect(env[MANAGED_BOOTSTRAP_FD_ENV]).toBe(String(MANAGED_BOOTSTRAP_CHILD_FD));
        expect(env[MANAGED_REPORT_FD_ENV]).toBe(String(MANAGED_REPORT_CHILD_FD));
        // Numbers, not documents: the secrets stay behind the descriptors.
        expect(env[MANAGED_BOOTSTRAP_FD_ENV]).toMatch(/^\d+$/);
        expect(env[MANAGED_REPORT_FD_ENV]).toMatch(/^\d+$/);
    });

    it('shouldNotPutTheTwoDocumentsOnTheSameDescriptor', () => {
        expect(MANAGED_BOOTSTRAP_CHILD_FD).not.toBe(MANAGED_REPORT_CHILD_FD);
    });
});

describe('managedCodexHomeAgrees', () => {
    it('shouldBeTheDirectoryTheBootPathAlreadyCreatesForTheProvider', async () => {
        // Named twice because importing the boot module here is a cycle; this
        // is what keeps a codex run from being pointed at a directory nobody
        // created and nothing checkpoints.
        const { managedCodexHome } = await import('@/managed/managedRuntimeBoot');
        expect(MANAGED_GENERATION_CODEX_HOME).toBe(managedCodexHome());
    });

    it('shouldBeCarriedIntoTheGenerationConfigSoACodexRunCanPark', () => {
        const config = composition().managedRun;
        // `planProviderLaunch` refuses a codex run without one, before the park.
        expect(config.codexHome).toBe(MANAGED_GENERATION_CODEX_HOME);
    });
});

describe('boundedGrantTtlMs', () => {
    it('shouldNeverLetAGrantOutliveTheWriteLease', () => {
        // The configured value is longer than what is left of the lease.
        expect(boundedGrantTtlMs({
            policy: POLICY, leaseExpiresMonotonic: 10_000, monotonicNow: 4_000,
        })).toBe(6_000);
    });

    it('shouldUseTheConfiguredValueWhenTheLeaseOutlastsIt', () => {
        expect(boundedGrantTtlMs({
            policy: POLICY, leaseExpiresMonotonic: 900_000, monotonicNow: 0,
        })).toBe(60_000);
    });

    it('shouldGiveNoGrantAtAllOnceTheLeaseHasGone', () => {
        expect(boundedGrantTtlMs({
            policy: POLICY, leaseExpiresMonotonic: 1_000, monotonicNow: 1_000,
        })).toBe(0);
    });
});


describe('managedImagePathsAgree', () => {
    it('shouldNameTheSameProgramsAsTheImageLayoutContract', () => {
        /*
         * The launcher and the image name these paths separately, because the
         * image's runtime entry is bundled into one read-only CommonJS file
         * and a module shared with the launcher's graph makes the bundler emit
         * a sibling chunk the image does not install. Two copies is the price;
         * this is what stops them drifting — a drift here means the helper is
         * handed a path the image never installed.
         */
        expect(TRUSTED_TOOL_WORKLOAD_PATH).toBe(MANAGED_TOOL_WORKLOAD_PATH);
        expect(TRUSTED_PROVIDER_EXEC_PATH).toBe(MANAGED_PROVIDER_EXEC_PATH);
        // The image-version file is the third copy, and it was imported rather
        // than copied until the sibling chunk it produced failed the image
        // build's own layout check.
        expect(MANAGED_IMAGE_VERSION_FILE).toBe(MANAGED_IMAGE_VERSION_PATH);
    });
});


describe('the image answers for itself', () => {
    it('shouldReadTheRunningImagesVersionRatherThanBeToldOne', () => {
        expect(readManagedImageVersion(() => '1.2.3-aplus.9\n')).toBe('1.2.3-aplus.9');
    });

    it('shouldRefuseAnEmptyVersionRatherThanLabelAnArchiveWithNothing', () => {
        expect(() => readManagedImageVersion(() => '  \n')).toThrow(/image version/);
    });

    it('shouldFillTheImageAndTheAreasWhenTheCallerSuppliesNeither', () => {
        /*
         * Both are image facts, not parent policy: the areas are fixed paths in
         * this image and the version is what it actually installed. A boot that
         * had to supply them could only get them from somewhere that can be
         * wrong about this machine.
         */
        const config = checkpointConfig() as unknown as Record<string, unknown>;
        delete config.areas;
        // `image` is supplied here only because a test has no image file to
        // read; `areas` is left out entirely, which is the point.
        const built = defaultManagedRunConfig({
            identity: identity(), policy: POLICY, onUnprovenTermination: () => undefined,
            serverOrigin: SERVER_ORIGIN, checkpoint: config as never,
        });
        expect(built.checkpoint.checkpointDrain).toBe(built.managedRun.checkpointDrain);
    });
});

describe('the provider-quiescence gate reaches the coordinator', () => {
    /*
     * 게이트는 supervisor 에서 만들어지고 supervisor 는 이 합성 **뒤에** 생긴다.
     * 그래서 값이 아니라 참조로 내려가야 하고, 그 참조가 중간에서 떨어지면
     * 증상은 "증명 없이 provider state 를 담는다" 뿐이라 조용하다.
     */
    const areas = managedCheckpointAreas({
        projectRoot: MANAGED_PROJECT_ROOT,
        providerStateRoot: MANAGED_GENERATION_CODEX_HOME,
    });
    const idle = { state: 'idle', forMs: 1 } as const;
    /** A target has to be in hand before the gate is consulted at all. */
    function targets() {
        const url = 'https://store.invalid/x';
        return {
            next: async () => ({
                checkpointId: 'a'.repeat(64),
                key: Buffer.alloc(32),
                targets: {
                    objects: new Map([
                        ['project', { putUrl: url, headUrl: url }],
                        ['provider-state', { putUrl: url, headUrl: url }],
                    ]),
                    manifest: { putUrl: url, headUrl: url },
                    pointer: { putUrl: url, getUrl: url },
                },
            }),
        };
    }

    it('shouldRefuseGateNotWiredWhileTheReferenceIsStillEmpty', async () => {
        const built = composition({
            checkpoint: checkpointConfig({
                areas,
                policy: { periodMs: 300_000, onTurnBoundary: true },
                targets: targets(),
                // supervisor 전: 참조는 있고 값은 없다.
                providerQuiescence: () => null,
            }),
        });
        expect(await built.checkpoint.coordinator.tick({
            trigger: 'turn-boundary', idle, now: 1_000_000,
        })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'quiescence-unavailable', detail: 'gate-not-wired' },
        });
    });

    it('shouldRefuseNoQuiescenceGateWhenNothingIsPassedAndProviderStateIsArchived', async () => {
        // 참조 자체가 없는 것은 다른 진술이다 — 그리고 그것도 provider state 를
        // 증명 없이 담아도 된다는 뜻이 아니다.
        const built = composition({
            checkpoint: checkpointConfig({
                areas,
                policy: { periodMs: 300_000, onTurnBoundary: true },
                targets: targets(),
            }),
        });
        expect(await built.checkpoint.coordinator.tick({
            trigger: 'turn-boundary', idle, now: 1_000_000,
        })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'no-quiescence-gate' },
        });
    });

    it('shouldAskTheGateTheReferenceAnswersWithAtTheMomentOfTheAttempt', async () => {
        // 늦게 배선된 게이트가 실제로 물어봐진다 — 참조는 시도할 때 읽는다.
        let asked = 0;
        let gate: { prove: () => Promise<never>; stillProven: () => boolean; release: () => Promise<void> } | null = null;
        const built = composition({
            checkpoint: checkpointConfig({
                areas,
                policy: { periodMs: 300_000, onTurnBoundary: true },
                providerQuiescence: () => gate,
                targets: targets(),
                workDir: mkdtempSync(join(tmpdir(), 'mrc-work-')),
            }),
        });
        gate = {
            prove: (async () => { asked += 1; return { quiesced: false, reason: 'exit-unobserved' }; }) as never,
            stillProven: () => false,
            release: async () => {},
        };
        expect(await built.checkpoint.coordinator.tick({
            trigger: 'turn-boundary', idle, now: 1_000_000,
        })).toEqual({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'exit-unobserved' },
        });
        // 시도 시점에 읽힌 그 게이트가 실제로 물어봐졌다.
        expect(asked).toBe(1);
    });
});

describe('the runtime cannot come up unable to checkpoint', () => {
    it('shouldRefuseARuntimeWithNoAreaToCapture', () => {
        /*
         * No area is not "checkpoint nothing": it is a checkpoint that succeeds
         * while capturing none of the run's work, which is the worst of the
         * three outcomes because it looks like the good one.
         */
        expect(() => composition({ checkpoint: checkpointConfig({ areas: [] }) }))
            .toThrow(/at least one area/);
    });

    it('shouldRefuseARuntimeWithNoDrainBudget', () => {
        expect(() => composition({ checkpoint: checkpointConfig({ drainBudgetMs: 0 }) }))
            .toThrow(/positive drainBudgetMs/);
    });

    it('shouldBuildTheRuntimesOneRunnerAndGiveItsGateToTheWriters', () => {
        const built = composition();
        // The generation's writers and the archive share this one gate.
        expect(built.managedRun.checkpointDrain).toBe(built.checkpoint.checkpointDrain);
        expect(built.checkpoint.coordinator.checkpointState()).toMatchObject({ saved: false });
    });

    it('shouldTreatAnExplicitTakeNoneAsADecisionRatherThanAMissingWire', async () => {
        // `policy: null` is legible in the state; an absent block is not a
        // decision at all, which is why it is a type error rather than a skip.
        const built = composition();
        expect(await built.checkpoint.coordinator.tick({
            trigger: 'periodic', idle: { idle: true, reason: 'no-activity' } as never, now: 1,
        })).toMatchObject({ attempted: false });
    });
});

describe('the default composition archives provider state', () => {
    it('shouldRefuseEveryCheckpointUntilSomethingCanProveTheProviderSettled', async () => {
        /*
         * The image's default areas are the project tree **and** the provider's
         * own state, and nothing yet builds a quiescence gate — so this pins the
         * runtime's current, deliberate behaviour: it takes no checkpoint rather
         * than archiving a provider state nobody proved was flushed.
         *
         * This assertion is expected to change when the gate is wired. That is
         * the point of it: the wiring is a behaviour change and has to show up
         * as one, instead of silently turning a refusal into a save.
         */
        const config = checkpointConfig({
            // A real schedule and a real target, so the refusal below is the
            // provider-state one and not the runtime declining for some
            // earlier reason.
            policy: { periodMs: 300_000, onTurnBoundary: true },
            targets: { next: async () => ({ checkpointId: 'a'.repeat(64), key: Buffer.alloc(32, 7), targets: {} }) },
        }) as unknown as Record<string, unknown>;
        delete config.areas;
        const built = defaultManagedRunConfig({
            identity: identity(), policy: POLICY, onUnprovenTermination: () => undefined,
            serverOrigin: SERVER_ORIGIN, checkpoint: config as never,
        });

        expect(built.checkpoint.runner.archivedAreas.has('provider-state')).toBe(true);

        const result = await built.checkpoint.coordinator.tick({
            trigger: 'turn-boundary',
            idle: { idle: true, reason: 'no-activity' } as never,
            now: 1_000_000,
        });
        expect(result).toEqual({
            attempted: false,
            decision: { take: false, reason: 'provider-state-unproven', detail: 'no-quiescence-gate' },
        });
        // And nothing may stop on the strength of it.
        expect(built.checkpoint.coordinator.checkpointState().saved).toBe(false);
    });
});

describe('the runtime\'s own server reaches the child', () => {
    /**
     * Two names on purpose. The dependency is `serverOrigin` — what this
     * machine was provisioned with, read back from the stored daemon
     * credential — and the environment key the child reads is
     * `HAPPY_SERVER_URL`. The child compares the envelope's relay origin
     * against its configured server, so configuring it *from* the envelope
     * would make that check compare the envelope with itself.
     */
    function providerEnv(over: Record<string, unknown>) {
        return composition(over).managedRun.providerEnvironment(envelope('claude'));
    }

    it('shouldGiveTheChildTheOriginTheRuntimeWasProvisionedWith', () => {
        /*
         * Three different origins are in play, on purpose:
         *   stored (the answer)     `https://provisioned.example.test`
         *   the envelope's own      `https://happy.example.test`
         *   this process's default  set below
         * Only the stored one may reach the child. Reading either of the other
         * two is a real implementation — the ambient default is what the CLI
         * would otherwise fall back to — so each has to be excluded by a value
         * that differs, not by an assertion that says so.
         */
        const before = process.env.HAPPY_SERVER_URL;
        process.env.HAPPY_SERVER_URL = 'https://ambient.example.test';
        try {
            expect(providerEnv({}).HAPPY_SERVER_URL).toBe(SERVER_ORIGIN);
        } finally {
            if (before === undefined) delete process.env.HAPPY_SERVER_URL;
            else process.env.HAPPY_SERVER_URL = before;
        }
    });

    it('shouldCarryWhicheverOriginTheRuntimeWasBuiltWith', () => {
        expect(providerEnv({ serverOrigin: 'https://other.example.test' }).HAPPY_SERVER_URL)
            .toBe('https://other.example.test');
    });
});
