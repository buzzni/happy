/**
 * aplus specs/codexcli-daemon-restart-drain — the machine-RPC side of the restart drain:
 * a drain refusal reaches Desktop with its code and deadline (R6), "지금 교대" is a narrow
 * RPC (R25), and `daemonState.lifecycle` survives the schema that strips unknown keys (R22).
 */
import { describe, expect, it, vi } from 'vitest';
import { DaemonStateSchema } from './types';
import { buildRestartLifecycle, withRestartLifecycle } from '@/daemon/restartDrainLifecycle';

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

async function handlers(extra: Record<string, unknown> = {}) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
        ...extra,
    } as any);
    return (method: string) => (client as any).rpcHandlerManager.handlers.get(`machine-1:${method}`) as ((params: any) => Promise<any>) | undefined;
}

describe('restart drain over machine RPC', () => {
    it('answers a spawn refused by the drain with code and deadline instead of throwing', async () => {
        const spawnSession = vi.fn().mockResolvedValue({
            type: 'error', code: 'daemon-restarting', errorMessage: 'Daemon is restarting; retry the launch after it is back', deadlineAt: 123,
        });
        const handler = (await handlers({ spawnSession }))('spawn-happy-session')!;
        await expect(handler({ directory: '/tmp/project' })).resolves.toEqual({
            type: 'error', code: 'daemon-restarting', errorMessage: 'Daemon is restarting; retry the launch after it is back', deadlineAt: 123,
        });
    });

    it('keeps throwing every other spawn failure, as older clients expect', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'error', errorMessage: 'boom' });
        const handler = (await handlers({ spawnSession }))('spawn-happy-session')!;
        await expect(handler({ directory: '/tmp/project' })).rejects.toThrow('boom');
    });

    it('registers restart-drain:force-handoff only when the daemon provides it', async () => {
        expect((await handlers({ spawnSession: vi.fn() }))('restart-drain:force-handoff')).toBeUndefined();
        const forceRestartHandoff = vi.fn().mockResolvedValue({ ok: false, code: 'no-pending-handoff' });
        const handler = (await handlers({ spawnSession: vi.fn(), forceRestartHandoff }))('restart-drain:force-handoff')!;
        await expect(handler({})).resolves.toEqual({ ok: false, code: 'no-pending-handoff' });
    });
});

describe('daemonState.lifecycle (R22)', () => {
    it('is preserved by DaemonStateSchema, including pendingHandoff and activity.inTurnCount', () => {
        const state = {
            status: 'running',
            activity: { activeSessionCount: 2, activeAutomationCount: 0, inTurnCount: 1, reportedAt: 1 },
            lifecycle: {
                state: 'draining', intent: 'restart', reason: 'env-reapply', inTurnCount: 1, openTerminalCount: 1,
                busyTerminalCount: 0, deadlineAt: 99, pendingHandoff: { detectedAt: 5, busyTerminalCount: 0, forceAvailable: false },
            },
        };
        expect(DaemonStateSchema.parse(state)).toEqual(state);
    });

    it('still parses a state from an older daemon without lifecycle', () => {
        expect(DaemonStateSchema.parse({ status: 'running' }).lifecycle).toBeUndefined();
    });

    it('publishes draining with counts while a drain is open, running otherwise', () => {
        expect(buildRestartLifecycle(null, null)).toEqual({ state: 'running' });
        expect(buildRestartLifecycle({
            version: 1, operationId: 'op', state: 'ready', intent: 'stop', reason: 'app-update', trigger: 'request',
            inTurnCount: 0, openTerminalCount: 2, busyTerminalCount: 1, deadlineAt: 10,
        }, { detectedAt: 1, busyTerminalCount: 1, forceAvailable: true })).toEqual({
            state: 'draining', intent: 'stop', reason: 'app-update', inTurnCount: 0, openTerminalCount: 2, busyTerminalCount: 1,
            deadlineAt: 10, pendingHandoff: { detectedAt: 1, busyTerminalCount: 1, forceAvailable: true },
        });
        expect(withRestartLifecycle({ status: 'running', lifecycle: { state: 'running' } }, null)).toEqual({ status: 'running' });
    });
});
