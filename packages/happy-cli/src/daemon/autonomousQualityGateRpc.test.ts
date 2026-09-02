import { describe, expect, it, vi } from 'vitest';
import { createAutonomousQualityGateRpcHandlers } from './autonomousQualityGateRpc';

describe('autonomous quality gate RPC handlers', () => {
    it('validates and routes versioned start/status/control commands', async () => {
        const registry = {
            start: vi.fn(async () => ({ runId: 'run-1' })),
            status: vi.fn(async () => ({ runId: 'run-1' })),
            control: vi.fn(async () => ({ accepted: true })),
        };
        const handlers = createAutonomousQualityGateRpcHandlers(registry);
        const start = {
            schemaVersion: 1,
            requestId: 'start-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            directory: '/repo',
            recipeRevision: 'a'.repeat(64),
            plan: { phases: [{ name: 'test', command: 'npm test', timeoutMs: 1_000 }] },
            limits: { maxContinuations: 3, maxTurns: 12, maxTokens: 80_000, timeoutMs: 1_800_000, maxGateAttempts: 3 },
        };

        await handlers.start(start);
        await handlers.status({ schemaVersion: 1, sessionId: 'session-1' });
        await handlers.control({
            schemaVersion: 1,
            requestId: 'pause-1',
            runId: 'run-1',
            expectedRevision: 99,
            action: 'pause',
        });

        expect(registry.start).toHaveBeenCalledWith(start);
        expect(registry.status).toHaveBeenCalledWith('session-1');
        expect(registry.control).toHaveBeenCalledWith(expect.objectContaining({ action: 'pause' }));
    });

    it('rejects malformed commands before they reach the registry', async () => {
        const registry = { start: vi.fn(), status: vi.fn(), control: vi.fn() };
        const handlers = createAutonomousQualityGateRpcHandlers(registry);

        await expect(handlers.start({ schemaVersion: 1, sessionId: 'session-1' })).rejects.toThrow();
        expect(registry.start).not.toHaveBeenCalled();
    });
});
