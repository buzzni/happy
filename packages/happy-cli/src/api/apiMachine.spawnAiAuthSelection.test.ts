/**
 * spawn param `aiAuthSelection` 의 수용/거절과 적용 결과 회신.
 *
 * `spawn-happy-session` 은 파라미터를 구조분해만 한다 — 모르는 필드는 조용히
 * 버려진다. 그래서 "받는다" 와 "닫힌 집합 밖을 거절한다" 둘 다 테스트가 필요하다.
 */
import { describe, expect, it, vi } from 'vitest';

function machineClient() {
    return {
        id: 'machine-1',
        encryptionKey: new Uint8Array(32),
        encryptionVariant: 'legacy',
    } as any;
}

function handlersFrom(client: any): Map<string, (params: any) => Promise<any>> {
    return client.rpcHandlerManager.handlers;
}

function rpcHandlers(overrides: Record<string, unknown> = {}) {
    return {
        spawnSession: () => Promise.resolve({ type: 'success', sessionId: 'happy-1' }),
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: {
            allocate: () => undefined,
            get: () => undefined,
            release: () => undefined,
            list: () => [],
            sweep: () => undefined,
        },
        ...overrides,
    } as any;
}

async function spawnHandler(spawnSession: unknown) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers(rpcHandlers({ spawnSession }));
    return handlersFrom(client).get('machine-1:spawn-happy-session')!;
}

describe('spawn 의 AI 인증 원천 선택', () => {
    it.each(['machine-personal', 'org-bundle'])('%s 선택을 daemon 까지 전달한다', async (kind) => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        await handler({ directory: '/tmp/project', agent: 'claude', aiAuthSelection: { kind } });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            aiAuthSelection: { kind },
        }));
    });

    it('선택이 없으면 기존 동작 그대로다 — 선택 필드를 지어내지 않는다', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const handler = await spawnHandler(spawnSession);

        const response = await handler({ directory: '/tmp/project', agent: 'claude' });

        expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
            aiAuthSelection: undefined,
        }));
        expect(response).toEqual({ type: 'success', sessionId: 'happy-1' });
    });

    it.each([
        { label: '닫힌 집합 밖의 종류', value: { kind: 'platform-glm' } },
        { label: 'kind 누락', value: {} },
        { label: '문자열', value: 'machine-personal' },
    ])('$label 은 spawn 전에 거절한다', async ({ value }) => {
        const spawnSession = vi.fn();
        const handler = await spawnHandler(spawnSession);

        await expect(handler({
            directory: '/tmp/project',
            agent: 'claude',
            aiAuthSelection: value,
        })).rejects.toThrow(/AI auth selection/);
        expect(spawnSession).not.toHaveBeenCalled();
    });

    it('daemon 이 거절하면 사유가 호출자에게 그대로 전달된다', async () => {
        const handler = await spawnHandler(() => Promise.resolve({
            type: 'error',
            errorMessage: "AI auth selection 'org-bundle' was requested but ...",
        }));

        await expect(handler({
            directory: '/tmp/project',
            agent: 'claude',
            aiAuthSelection: { kind: 'org-bundle' },
        })).rejects.toThrow(/AI auth selection 'org-bundle' was requested/);
    });

    it('적용된 원천을 성공 응답에 싣는다', async () => {
        const handler = await spawnHandler(() => Promise.resolve({
            type: 'success',
            sessionId: 'happy-1',
            appliedAiAuthSource: 'platform-glm',
        }));

        const response = await handler({ directory: '/tmp/project', agent: 'claude' });

        expect(response).toEqual({
            type: 'success',
            sessionId: 'happy-1',
            appliedAiAuthSource: 'platform-glm',
        });
    });

    it('daemon 이 원천을 말하지 않으면 응답도 말하지 않는다', async () => {
        const handler = await spawnHandler(() => Promise.resolve({
            type: 'success',
            sessionId: 'happy-1',
        }));

        expect(await handler({ directory: '/tmp/project', agent: 'claude' }))
            .toEqual({ type: 'success', sessionId: 'happy-1' });
    });
});
