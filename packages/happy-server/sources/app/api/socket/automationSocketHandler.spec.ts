import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
    ackAutomationSync: vi.fn(),
    claimAutomationRun: vi.fn(),
    heartbeatAutomationRun: vi.fn(),
    registerAutomationMachineKey: vi.fn(),
    reportAutomationRun: vi.fn(),
    startAutomationRun: vi.fn(),
    syncAutomations: vi.fn(),
    emitAutomationUpdate: vi.fn(),
}));
vi.mock('@/app/automation/automationExecutionService', () => services);
vi.mock('@/app/automation/automationUpdate', () => ({ emitAutomationUpdate: services.emitAutomationUpdate }));
vi.mock('@/storage/inTx', () => ({ inTx: (callback: (tx: unknown) => unknown) => callback({}) }));

import { automationSocketHandler } from './automationSocketHandler';

describe('automationSocketHandler', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.SAYCODE_AUTOMATION_ENABLED = 'true';
    });
    afterEach(() => delete process.env.SAYCODE_AUTOMATION_ENABLED);

    it('fails closed when the global rollout flag is disabled', async () => {
        process.env.SAYCODE_AUTOMATION_ENABLED = 'false';
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        automationSocketHandler('account-1', 'machine-1', socket as never);

        const callback = vi.fn();
        await handlers.get('automation-sync')!({ afterSeq: '0', limit: 100 }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: false, error: 'feature-disabled' });
        expect(services.syncAutomations).not.toHaveBeenCalled();
    });

    it('registers the machine-only surface and ignores body identity fields', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.syncAutomations.mockResolvedValue({
            ok: true,
            value: { serverTime: new Date(10), nextSeq: 2n, changes: [{
                seq: 2n, kind: 'UPSERT', payloadCiphertext: new Uint8Array([1]), machineKeyEnvelope: new Uint8Array([2]),
            }] },
        });
        automationSocketHandler('account-1', 'machine-1', socket as never);

        expect([...handlers.keys()].sort()).toEqual([
            'automation-claim', 'automation-key-register', 'automation-run-heartbeat',
            'automation-run-report', 'automation-run-start', 'automation-sync', 'automation-sync-ack',
        ]);
        const callback = vi.fn();
        await handlers.get('automation-sync')!({ afterSeq: '0', limit: 100, machineId: 'foreign' }, callback);
        expect(services.syncAutomations).toHaveBeenCalledWith({}, 'account-1', 'machine-1', { afterSeq: 0n, limit: 100 });
        expect(callback).toHaveBeenCalledWith({ ok: true, value: expect.objectContaining({
            nextSeq: '2',
            changes: [expect.objectContaining({ payloadCiphertext: 'AQ==', machineKeyEnvelope: 'Ag==' })],
        }) });
    });

    it('accepts a safe automation failure code and rejects unstructured values', async () => {
        const handlers = new Map<string, Function>();
        const socket = { on: vi.fn((event: string, handler: Function) => handlers.set(event, handler)) };
        services.reportAutomationRun.mockResolvedValue({ ok: true, value: { idempotent: false } });
        automationSocketHandler('account-1', 'machine-1', socket as never);

        const accepted = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-1', claimToken: 'claim', reportId: 'report-1', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'CONNECTOR_RUNTIME_UNAVAILABLE',
            degradedCode: null,
        }, accepted);
        expect(services.reportAutomationRun).toHaveBeenCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({
                failureCode: 'CONNECTOR_RUNTIME_UNAVAILABLE',
                degradedCode: null,
            }),
        );

        const degraded = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-2', claimToken: 'claim', reportId: 'report-2', status: 'COMPLETED',
            outcome: 'WOKE', sessionId: 'session-1', detailCiphertext: null, failureCode: null,
            degradedCode: 'GRANT_MISSING',
        }, degraded);
        expect(services.reportAutomationRun).toHaveBeenLastCalledWith(
            {}, 'account-1', 'machine-1', expect.objectContaining({ degradedCode: 'GRANT_MISSING' }),
        );

        const rejected = vi.fn();
        await handlers.get('automation-run-report')!({
            runId: 'run-2', claimToken: 'claim', reportId: 'report-2', status: 'FAILED',
            outcome: 'ERROR', sessionId: null, detailCiphertext: null,
            failureCode: 'secret: do not log',
        }, rejected);
        expect(rejected).toHaveBeenCalledWith({ ok: false, error: 'invalid-input' });
    });
});
