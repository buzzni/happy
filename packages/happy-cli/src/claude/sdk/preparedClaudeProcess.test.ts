import { describe, expect, it, vi } from 'vitest';
import type { CanUseTool, ClaimOptions, Options, SDKUserMessage, SpareProcess } from '@anthropic-ai/claude-agent-sdk';
import { prepareClaudeProcess } from './preparedClaudeProcess';

const { prewarm } = vi.hoisted(() => ({ prewarm: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ prewarm }));

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
    return { promise, resolve, reject };
}

function fixture() {
    const acceptance = deferred<Awaited<SpareProcess['claimed']>>();
    const status = deferred<{ name: string; status: string }[]>();
    const attach = vi.fn(async () => ({ added: ['happy'], removed: [], errors: {} }));
    const query = { setMcpServers: attach, mcpServerStatus: vi.fn(() => status.promise) };
    const firstRead = vi.fn();
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
        firstRead();
        yield { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: 'fixture' } };
    }
    let stagedRead: Promise<IteratorResult<SDKUserMessage>>;
    const claim = vi.fn((input: { prompt: AsyncIterable<SDKUserMessage>; options: ClaimOptions }) => {
        stagedRead = input.prompt[Symbol.asyncIterator]().next();
        return query;
    });
    const exit = deferred<void>();
    const close = vi.fn(() => exit.resolve());
    prewarm.mockResolvedValueOnce({ claim, claimed: acceptance.promise, exited: exit.promise, close });
    const allowTool = vi.fn<CanUseTool>(async () => ({ behavior: 'allow' }));
    return {
        acceptance, status, query, close, claim, firstRead, allowTool,
        get stagedRead() { return stagedRead; },
        accept: () => acceptance.resolve({ cwd: 'fixture', sessionId: 'fixture', sdkMcpSettled: true }),
        input: { options: { cwd: 'fixture' }, prompt: prompt(), mcpServers: { happy: { command: 'fixture' } }, requiredMcp: ['happy'], allowTool },
    };
}

describe('prepared Claude process', () => {
    it('holds the first input and tool approvals until the single claim and required MCP are ready', async () => {
        const f = fixture();
        const lease = await prepareClaudeProcess({ includePartialMessages: true });
        const { canUseTool } = prewarm.mock.lastCall![0].options as Options;
        const tool = { signal: new AbortController().signal, toolUseID: 'tool' } as Parameters<CanUseTool>[2];
        expect(await canUseTool!('Read', {}, tool)).toMatchObject({ behavior: 'deny' });
        const active = lease.claim(f.input);
        expect(f.firstRead).not.toHaveBeenCalled();
        await expect(lease.claim(f.input)).rejects.toThrow('unavailable');
        f.accept();
        await vi.waitFor(() => expect(f.query.mcpServerStatus).toHaveBeenCalled());
        expect(await canUseTool!('Read', {}, tool)).toMatchObject({ behavior: 'deny' });
        expect(f.firstRead).not.toHaveBeenCalled();
        f.status.resolve([{ name: 'happy', status: 'connected' }]);
        await expect(active).resolves.toBe(f.query);
        await expect(f.stagedRead).resolves.toMatchObject({ done: false });
        expect(f.firstRead).toHaveBeenCalledTimes(1);
        expect(await canUseTool!('Read', {}, tool)).toMatchObject({ behavior: 'allow' });
        await lease.dispose();
        expect(f.close).toHaveBeenCalledTimes(1);
    });

    it.each(['option_not_applied', 'canceled after claim'])('closes on %s without reading the user input', async (reason) => {
        const f = fixture();
        const signal = new AbortController();
        const lease = await prepareClaudeProcess({});
        const active = lease.claim({ ...f.input, signal: signal.signal });
        const failed = expect(active).rejects.toThrow(reason);
        if (reason === 'option_not_applied') f.acceptance.reject(new Error(reason));
        else {
            f.accept();
            await vi.waitFor(() => expect(f.query.mcpServerStatus).toHaveBeenCalled());
            signal.abort(new Error(reason));
        }
        await failed;
        await expect(f.stagedRead).resolves.toMatchObject({ done: true });
        expect(f.firstRead).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledTimes(1);
    });

    it('closes when an attached required server rejects the connection', async () => {
        const f = fixture();
        const lease = await prepareClaudeProcess({});
        f.accept();
        f.status.resolve([{ name: 'happy', status: 'failed' }]);
        await expect(lease.claim(f.input)).rejects.toThrow('Required Claude MCP is unavailable');
        await expect(f.stagedRead).resolves.toMatchObject({ done: true });
        expect(f.firstRead).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledTimes(1);
    });

    it('keeps input and MCP unopened when the provider cannot confirm late settings', async () => {
        const f = fixture();
        const lease = await prepareClaudeProcess({});
        f.accept();
        await expect(lease.claim({ ...f.input, verifyClaim: async () => { throw new Error('settings not verified'); } }))
            .rejects.toThrow('settings not verified');
        await expect(f.stagedRead).resolves.toMatchObject({ done: true });
        expect(f.firstRead).not.toHaveBeenCalled();
        expect(f.query.setMcpServers).not.toHaveBeenCalled();
        expect(f.close).toHaveBeenCalledTimes(1);
    });
});
