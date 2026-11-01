/**
 * aplus specs/org-agent-plan §6.3-1·§6.3-2 — spawn param `agentPlan` and the `agentPlan` capability.
 *
 * `spawn-happy-session` only destructures its params, so an unknown field is dropped silently and the session
 * runs on the machine's own Codex login. Both "forwarded" and "refused when malformed" need a test.
 */
import { describe, expect, it, vi } from 'vitest';

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

function rpcHandlers(overrides: Record<string, unknown> = {}) {
    return {
        spawnSession: () => Promise.resolve({ type: 'success', sessionId: 'happy-1' }),
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
        ...overrides,
    } as any;
}

async function spawnHandler(spawnSession: unknown) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers(rpcHandlers({ spawnSession }));
    return (client as any).rpcHandlerManager.handlers.get('machine-1:spawn-happy-session') as (params: any) => Promise<any>;
}

describe('spawn 의 정액 플랜 grant 봉투', () => {
    it('봉투를 daemon 까지 그대로 전달한다', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', agent: 'codex', agentPlan: { grantEnvelope: 'c2VhbGVk' } });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ agentPlan: { grantEnvelope: 'c2VhbGVk' } }));
    });

    it('플랜이 없으면 필드를 지어내지 않는다', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', agent: 'codex' });

        expect(spawnSession.mock.calls[0]![0]).not.toHaveProperty('agentPlan');
    });

    it.each([
        { label: '빈 봉투', value: { grantEnvelope: '' } },
        { label: '추가 필드', value: { grantEnvelope: 'a', secret: 'x' } },
        { label: '문자열', value: 'c2VhbGVk' },
    ])('$label 은 spawn 전에 거절한다', async ({ value }) => {
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession);

        await expect(handler({ directory: '/tmp/project', agent: 'codex', agentPlan: value })).rejects.toThrow(/Agent plan/);
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('aiAuthSelection 과 함께 오면 어느 쪽도 고르지 않고 거절한다', async () => {
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession);

        await expect(handler({
            directory: '/tmp/project',
            agent: 'codex',
            agentPlan: { grantEnvelope: 'c2VhbGVk' },
            aiAuthSelection: { kind: 'machine-personal' },
        })).rejects.toThrow(/agent_plan_conflicting_selection/);
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('daemon 의 거절 코드가 호출자에게 그대로 전달된다', async () => {
        const handler = await spawnHandler(() => Promise.resolve({
            type: 'error', errorMessage: 'Agent plan grant rejected (agent_plan_wrong_machine)',
        }));

        await expect(handler({ directory: '/tmp/project', agent: 'codex', agentPlan: { grantEnvelope: 'c2VhbGVk' } }))
            .rejects.toThrow(/agent_plan_wrong_machine/);
    });
});
