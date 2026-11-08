/**
 * `launchMcpServers` on `spawn-happy-session` / `resume-happy-session` and the `launchMcpServers`
 * daemon-state capability (aplus-dev-studio-desktop specs/extension-session-and-worktree-hooks).
 *
 * Both RPCs destructure their parameters, so an unread field is dropped without a word: the field
 * must reach the daemon, and the daemon's drop report must reach the answer.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { DaemonStateSchema } from './types';

const SECRET = 'sentinel-launch-mcp-rpc-41d2b7';

const launchMcpServers = {
    files: { transport: 'stdio', command: 'node', args: [`--token=${SECRET}`], env: { TOKEN: SECRET } },
    docs: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: `Bearer ${SECRET}` } },
    Bad: { transport: 'stdio', command: 'node', env: { TOKEN: SECRET } },
};

function machineClient() {
    return { id: 'machine-1', encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy' } as any;
}

async function handlers(spawnSession: unknown, resumeSession: unknown) {
    const { ApiMachineClient } = await import('./apiMachine');
    const client = new ApiMachineClient('token', machineClient());
    client.setRPCHandlers({
        spawnSession,
        resumeSession,
        stopSession: () => Promise.resolve(),
        requestShutdown: () => Promise.resolve(),
        portRegistry: { allocate: () => undefined, get: () => undefined, release: () => undefined, list: () => [], sweep: () => undefined },
    } as any);
    const registered = (client as any).rpcHandlerManager.handlers as Map<string, (params: any) => Promise<any>>;
    return {
        client,
        spawn: registered.get('machine-1:spawn-happy-session')!,
        resume: registered.get('machine-1:resume-happy-session')!,
    };
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe('launchMcpServers RPC field', () => {
    it('hands spawn the checked request and answers with the drops', async () => {
        const dropped = [{ name: 'Bad', reason: 'invalid' }, { name: 'docs', reason: 'name-conflict' }];
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1', launchMcpDropped: dropped });
        const { spawn } = await handlers(spawnSession, vi.fn());

        const answer = await spawn({ directory: '/tmp/project', agent: 'claude', launchMcpServers });

        expect(spawnSession.mock.calls[0][0].launchMcpServers).toEqual({
            servers: {
                files: launchMcpServers.files,
                docs: launchMcpServers.docs,
            },
            dropped: [{ name: 'Bad', reason: 'invalid' }],
        });
        expect(answer).toEqual({ type: 'success', sessionId: 'happy-1', launchMcpDropped: dropped });
    });

    it('hands resume the checked request and answers with the drops', async () => {
        const dropped = [{ name: 'files', reason: 'unsupported-agent' }];
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1', launchMcpDropped: dropped });
        const { resume } = await handlers(vi.fn(), resumeSession);

        const answer = await resume({ sessionId: 'happy-1', launchMcpServers });

        expect(resumeSession.mock.calls[0][1].launchMcpServers.servers).toEqual({ files: launchMcpServers.files, docs: launchMcpServers.docs });
        expect(answer).toEqual({ type: 'success', sessionId: 'happy-1', launchMcpDropped: dropped });
    });

    it('leaves a request without the field exactly as before', async () => {
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { spawn, resume } = await handlers(spawnSession, resumeSession);

        expect(await spawn({ directory: '/tmp/project', agent: 'claude' })).toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(await resume({ sessionId: 'happy-1' })).toEqual({ type: 'success', sessionId: 'happy-1' });
        expect(spawnSession.mock.calls[0][0]).not.toHaveProperty('launchMcpServers');
        expect(resumeSession.mock.calls[0][1]).not.toHaveProperty('launchMcpServers');
    });

    it('logs none of the values it carries', async () => {
        const lines: string[] = [];
        const record = (...args: unknown[]) => { lines.push(args.map((arg) => typeof arg === 'string' ? arg : JSON.stringify(arg)).join(' ')); };
        for (const level of ['debug', 'info', 'warn', 'infoDeveloper'] as const) vi.spyOn(logger, level).mockImplementation(record);
        const spawnSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const resumeSession = vi.fn().mockResolvedValue({ type: 'success', sessionId: 'happy-1' });
        const { spawn, resume } = await handlers(spawnSession, resumeSession);

        await spawn({ directory: '/tmp/project', agent: 'claude', launchMcpServers });
        await resume({ sessionId: 'happy-1', launchMcpServers });

        expect(lines.length).toBeGreaterThan(0);
        expect(lines.join('\n')).not.toContain(SECRET);
    });
});

describe('launchMcpServers capability', () => {
    it('is part of every daemon state this process publishes', async () => {
        const { client } = await handlers(vi.fn(), vi.fn());
        const published: unknown[] = [];
        const { decodeBase64, decrypt } = await import('./encryption');
        Object.assign(client, { socket: { emitWithAck: vi.fn(async (_event: string, request: { daemonState: string; expectedVersion: number }) => {
            published.push(decrypt(new Uint8Array(32), 'legacy', decodeBase64(request.daemonState)));
            return { result: 'success', version: request.expectedVersion + 1, daemonState: request.daemonState };
        }) } });

        await client.updateDaemonState((state) => ({ ...state, status: 'running' }));

        expect(published[0]).toMatchObject({ launchMcpServers: 1 });
        expect(DaemonStateSchema.parse(published[0])).toMatchObject({ launchMcpServers: 1 });
        expect(DaemonStateSchema.parse({ status: 'running' }).launchMcpServers).toBeUndefined();
    });
});
