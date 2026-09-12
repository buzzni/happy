import { describe, expect, it } from 'vitest';

import { verifySandboxExecutionCapability } from './executionCapability';

const BWRAP_NAMESPACE_ERROR = 'bwrap: Creating new namespace failed: Operation not permitted';

describe('verifySandboxExecutionCapability', () => {
    // 의존성 검사(checkDependencies)는 바이너리 존재만 본다. 비특권 컨테이너에서는
    // 그 검사와 initialize 가 모두 통과하고 자식 exec 에서 죽는다 — 그래서 실제로
    // 감싼 명령을 한 번 돌려 본다.
    it('reports capable when the wrapped probe command exits zero', async () => {
        const result = await verifySandboxExecutionCapability({
            wrap: async (command) => `bwrap-wrapped ${command}`,
            run: async () => ({ code: 0, stderr: '' }),
        });

        expect(result.ok).toBe(true);
    });

    it('runs the probe through the same wrapper the session will use', async () => {
        const wrapped: string[] = [];
        const ran: string[] = [];
        await verifySandboxExecutionCapability({
            wrap: async (command) => { wrapped.push(command); return `wrapped:${command}`; },
            run: async (command) => { ran.push(command); return { code: 0, stderr: '' }; },
        });

        expect(wrapped).toHaveLength(1);
        expect(ran).toEqual([`wrapped:${wrapped[0]}`]);
    });

    // 원인과 증상이 멀어지는 지점이다. "exit 1" 로 뭉개지 말고 이름을 붙인다.
    it('names a namespace denial so the operator knows it is the kernel, not the app', async () => {
        const result = await verifySandboxExecutionCapability({
            wrap: async (command) => command,
            run: async () => ({ code: 1, stderr: BWRAP_NAMESPACE_ERROR }),
        });

        expect(result).toMatchObject({ ok: false, reason: 'namespace-denied' });
        if (!result.ok) expect(result.detail).toContain('Creating new namespace failed');
    });

    it('reports an unclassified failure separately from a namespace denial', async () => {
        const result = await verifySandboxExecutionCapability({
            wrap: async (command) => command,
            run: async () => ({ code: 127, stderr: 'sh: rg: not found' }),
        });

        expect(result).toMatchObject({ ok: false, reason: 'unknown' });
    });

    it('reports a wrapper failure instead of throwing', async () => {
        const result = await verifySandboxExecutionCapability({
            wrap: async () => { throw new Error('sandbox not initialized'); },
            run: async () => ({ code: 0, stderr: '' }),
        });

        expect(result).toMatchObject({ ok: false, reason: 'unknown' });
        if (!result.ok) expect(result.detail).toContain('sandbox not initialized');
    });
});
