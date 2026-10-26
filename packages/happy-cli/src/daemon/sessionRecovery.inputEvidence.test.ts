import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

import type { RecoverSessionOptions, RecoverSessionResult, SpawnSessionOptions } from '@/modules/common/registerCommonHandlers';
import type { PersistedSession } from '@/persistence';
import type { ReconnectableHappySession } from '@/resume/resolveHappySession';
import * as inputEvidenceSettings from '@/utils/inputEvidenceSettings';
import * as sessionEnv from './sessionEnv';
import * as sessionRecovery from './sessionRecovery';

// run.ts owns this closure inside daemon startup. Execute the actual boundary,
// mocking only lookup, storage and process launch; keep decision/setting/env code real.
const source = ts.createSourceFile('run.ts', readFileSync(new URL('./run.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
let recoveryExpression: string | undefined;
function findRecovery(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'spawnRecoveredSession') {
        recoveryExpression = node.initializer?.getText(source);
    }
    ts.forEachChild(node, findRecovery);
}
findRecovery(source);
if (!recoveryExpression) throw new Error('spawnRecoveredSession not found');
const compiled = ts.transpileModule(`const recover = ${recoveryExpression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function recoveryHarness(agent: 'claude' | 'codex', input: {
    cursor?: number;
    saved?: string;
    marker?: boolean;
    missingRecord?: boolean;
}) {
    const metadata = {
        path: '/workspace/owned',
        flavor: agent,
        ...(agent === 'claude' ? { claudeSessionId: 'native-owner' } : { codexThreadId: 'native-owner' }),
        ...(input.marker !== undefined ? { inputEvidenceEnabled: input.marker } : {}),
    } as ReconnectableHappySession['metadata'];
    const serverSession = { id: 'original', active: false, metadata } as ReconnectableHappySession;
    const persisted = input.missingRecord ? undefined : {
        metadata,
        encryptionKey: Buffer.alloc(32).toString('base64'),
        encryptionVariant: 'dataKey',
        seq: 20,
        metadataVersion: 1,
        agentStateVersion: 1,
        savedAt: 1,
        lastProcessedSeq: input.cursor,
        agentEnvironment: {
            ...(input.saved !== undefined ? { HAPPY_INPUT_EVIDENCE: input.saved } : {}),
            HAPPY_PROJECT_SANDBOX_CONFIG: '{"enabled":true}',
            SAYCODE_AGENT_ENV: '1',
            SAYCODE_AGENT_ROOT: '/old/root',
            SAYCODE_AGENT_ID: 'previous-owner',
            OLD_PROJECT_VARIABLE: 'do-not-copy',
        },
    } as PersistedSession;
    let childEnvironment: Record<string, string> = {};
    const spawnSession = vi.fn(async (options: SpawnSessionOptions) => {
        childEnvironment = sessionEnv.buildManagedSessionSpawnEnvironment(
            { HAPPY_INPUT_EVIDENCE: '1' },
            sessionEnv.buildSpawnRequestEnvironment({}, options.environmentVariables),
            {},
        );
        return { type: 'success', sessionId: 'replacement' };
    });
    const dependencies = {
        ...sessionRecovery,
        ...sessionEnv,
        ...inputEvidenceSettings,
        resolveReconnectableSession: async () => serverSession,
        fs: { access: async () => {} },
        verifyRecoveryNativeSession: async () => true,
        readPersistedSessions: () => ({ original: persisted }),
        spawnSession,
    };
    const recover = Function(...Object.keys(dependencies), `${compiled}; return recover;`)(...Object.values(dependencies)) as
        (sessionId: string, options: RecoverSessionOptions) => Promise<RecoverSessionResult>;
    return { recover, spawnSession, environment: () => childEnvironment };
}

const settings = [
    { label: 'metadata only', marker: true, expected: true },
    { label: 'saved ON only', saved: '1', expected: true },
    { label: 'saved OFF beats metadata ON', saved: '0', marker: true, expected: false },
    { label: 'saved ON beats metadata OFF', saved: '1', marker: false, expected: true },
    { label: 'invalid saved value falls back to metadata', saved: 'true', marker: true, expected: true },
    { label: 'no setting defaults OFF', expected: false },
];

describe.each(['claude', 'codex'] as const)('T2RT-28 %s replacement-ID recovery', agent => {
    for (const cursor of [undefined, -1]) {
        for (const setting of settings) {
            it.each([undefined, '0', '1'])(`${cursor === undefined ? 'absent' : 'corrupt'} cursor, ${setting.label}, override %s`, async override => {
                const harness = recoveryHarness(agent, { ...setting, cursor });
                const environmentVariables = {
                    NEW_PROJECT_VARIABLE: 'keep-request',
                    ...(override !== undefined ? { HAPPY_INPUT_EVIDENCE: override } : {}),
                };
                const originalRequest = { ...environmentVariables };
                expect(await harness.recover('original', { initialPrompt: 'continue', environmentVariables })).toMatchObject({
                    type: 'success', sessionId: 'replacement', previousSessionId: 'original', recovery: 'new-session',
                });
                expect(harness.spawnSession).toHaveBeenCalledOnce();
                const launched = harness.spawnSession.mock.calls[0][0];
                expect(launched).toMatchObject({ parentSessionId: 'original', agent,
                    [agent === 'claude' ? 'resumeClaudeSessionId' : 'resumeCodexThreadId']: 'native-owner' });
                expect(launched.reconnectEnvironment).toBeUndefined();
                expect(launched.environmentVariables?.NEW_PROJECT_VARIABLE).toBe('keep-request');
                for (const key of ['HAPPY_PROJECT_SANDBOX_CONFIG', 'SAYCODE_AGENT_ENV', 'SAYCODE_AGENT_ROOT', 'SAYCODE_AGENT_ID', 'OLD_PROJECT_VARIABLE']) {
                    expect(launched.environmentVariables).not.toHaveProperty(key);
                }
                expect(environmentVariables).toEqual(originalRequest);
                const child = { ...harness.environment() };
                const enabled = inputEvidenceSettings.resolveInputEvidenceOption(inputEvidenceSettings.consumeInputEvidenceOption(child));
                expect(enabled).toBe(override === undefined ? setting.expected : override === '1');

                // A later unrelated new session must not inherit the recovered flag.
                const unrelated = sessionEnv.buildManagedSessionSpawnEnvironment(harness.environment(),
                    sessionEnv.buildSpawnRequestEnvironment({}, {}), {});
                expect(inputEvidenceSettings.resolveInputEvidenceOption(inputEvidenceSettings.consumeInputEvidenceOption(unrelated))).toBe(false);
            });
        }
    }

    it('uses original metadata when the whole persisted record is absent', async () => {
        const harness = recoveryHarness(agent, { missingRecord: true, marker: true });
        await harness.recover('original', { initialPrompt: 'continue' });
        expect(inputEvidenceSettings.resolveInputEvidenceOption(
            inputEvidenceSettings.consumeInputEvidenceOption(harness.environment()),
        )).toBe(true);
    });

    it.each(['true', '', '2'])('rejects invalid explicit setting %j before spawning', async value => {
        const harness = recoveryHarness(agent, { marker: true });
        await expect(harness.recover('original', { initialPrompt: 'continue', environmentVariables: { HAPPY_INPUT_EVIDENCE: value } }))
            .rejects.toThrow(/HAPPY_INPUT_EVIDENCE/);
        expect(harness.spawnSession).not.toHaveBeenCalled();
    });
});
