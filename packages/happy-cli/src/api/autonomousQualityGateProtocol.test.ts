import { describe, expect, it } from 'vitest';

import {
    AutonomousQualityGateCapabilityV1Schema,
    AutonomousQualityGateControlRequestV1Schema,
    AutonomousQualityGateStartRequestV1Schema,
    AutonomousQualityGateStatusV1Schema,
} from './autonomousQualityGateProtocol';

const startRequest = {
    schemaVersion: 1,
    requestId: 'request-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    directory: '/workspace/project',
    recipeRevision: 'a'.repeat(64),
    plan: {
        phases: [
            { name: 'build', command: 'npm run build', timeoutMs: 120_000 },
            { name: 'test', command: 'npm test', timeoutMs: 120_000 },
        ],
    },
    limits: {
        maxContinuations: 3,
        maxTurns: 12,
        maxTokens: 80_000,
        timeoutMs: 1_800_000,
        maxGateAttempts: 3,
    },
};

describe('autonomous quality gate v1 protocol', () => {
    it('accepts v1 capability and ignores additive future fields', () => {
        expect(AutonomousQualityGateCapabilityV1Schema.parse({
            apiVersion: 1,
            rpcAvailable: true,
            future: 'ignored',
        })).toEqual({ apiVersion: 1, rpcAvailable: true });
    });

    it('accepts bounded start and control requests', () => {
        expect(AutonomousQualityGateStartRequestV1Schema.parse(startRequest)).toEqual(startRequest);
        expect(AutonomousQualityGateControlRequestV1Schema.parse({
            schemaVersion: 1,
            requestId: 'request-2',
            runId: 'run-1',
            expectedRevision: 4,
            action: 'pause',
        })).toMatchObject({ action: 'pause', expectedRevision: 4 });
    });

    it.each([
        { ...startRequest, schemaVersion: 2 },
        { ...startRequest, recipeRevision: 'not-a-hash' },
        { ...startRequest, plan: { phases: [] } },
        { ...startRequest, plan: { phases: [{ name: 'test', command: 'x'.repeat(8_193), timeoutMs: 1_000 }] } },
        { ...startRequest, limits: { ...startRequest.limits, maxContinuations: 0 } },
    ])('rejects malformed or unbounded start requests', (input) => {
        expect(AutonomousQualityGateStartRequestV1Schema.safeParse(input).success).toBe(false);
    });

    it('parses a forward-compatible secret-free status response', () => {
        const parsed = AutonomousQualityGateStatusV1Schema.parse({
            schemaVersion: 1,
            runId: 'run-1',
            revision: 3,
            sessionId: 'session-1',
            projectId: 'project-1',
            stage: 'repairing',
            attempt: 1,
            usage: { continuations: 1, turns: 2, tokens: 400, elapsedMs: 5_000 },
            limits: startRequest.limits,
            lastPhase: { name: 'test', status: 'failed', exitCode: 1, timedOut: false, outputTruncated: true },
            fingerprintChanged: false,
            nextAction: 'repair',
            future: { nested: true },
        });

        expect(parsed).not.toHaveProperty('future');
        expect(parsed.lastPhase).toEqual({
            name: 'test', status: 'failed', exitCode: 1, timedOut: false, outputTruncated: true,
        });
        expect(parsed.lastPhase).not.toHaveProperty('command');
        expect(parsed.lastPhase).not.toHaveProperty('cwd');
        expect(parsed.lastPhase).not.toHaveProperty('output');
    });
});
