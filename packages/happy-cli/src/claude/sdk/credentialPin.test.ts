import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryWithPinnedCredential } from './credentialPin';
import { logger } from '@/lib';
const TOKEN = 'fixture-owner-token';
function fixture() {
    let effective: Record<string, any> = { apiKeyHelper: 'wrong helper', env: { CLAUDE_CODE_OAUTH_TOKEN: 'wrong' } };
    const received: SDKUserMessage[] = [];
    const controls = {
        initializationResult: vi.fn(async () => ({ claude_code_version: '2.1.308', hooks_applied: true })),
        getSettings: vi.fn(async () => ({ effective, sources: [{ source: 'flagSettings', settings: { env: { KEEP_FLAG_ENV: 'yes' }, permissions: { deny: ['Bash(deploy)'] } } }] })),
        applyFlagSettings: vi.fn(async (settings: Record<string, any>) => { effective = { ...effective, ...settings }; }),
        reinitialize: vi.fn(async () => ({ account: { apiProvider: 'firstParty' as string, tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } })),
        request: vi.fn(async () => ({ response: {} })),
        close: vi.fn(),
    };
    const create = vi.fn(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
        for await (const message of prompt) { received.push(message); yield { type: 'result', subtype: 'success' }; }
    })(), controls) as unknown as Query);
    return { controls, create, received, tamper: () => { effective.env.ANTHROPIC_BASE_URL = 'https://wrong.example.test'; }, restrictOrganization: () => { effective.forceLoginOrgUUID = 'fixture-org'; } };
}
const options: Options = { env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, settingSources: ['user', 'project', 'local'] };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('pinned credential at the SDK request boundary', () => {
    it('applies only credential flags before input, preserving settings sources and existing flag env', async () => {
        const f = fixture(); const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        await q.next();
        expect(f.controls.applyFlagSettings).toHaveBeenCalledOnce();
        expect(f.controls.applyFlagSettings.mock.calls[0][0]).toMatchObject({ apiKeyHelper: '', env: { CLAUDE_CODE_OAUTH_TOKEN: TOKEN, ANTHROPIC_API_KEY: '', KEEP_FLAG_ENV: 'yes' } });
        expect(Object.keys(f.controls.applyFlagSettings.mock.calls[0][0]).sort()).toEqual(['apiKeyHelper', 'env']);
        expect(f.create.mock.calls[0][0]).toMatchObject({ options });
        expect(f.received).toHaveLength(1); expect(f.received[0].message.content).toBe('hello');
    });
    it.each(['missing-control', 'old-version', 'new-minor', 'new-major', 'overlay-refused', 'managed-override', 'wrong-account', 'restricted-org', 'aborted'])(
        'refuses %s before input and exposes a sanitized failure', async kind => {
            const f = fixture();
            if (kind === 'missing-control') f.controls.getSettings = undefined as never;
            if (kind === 'old-version') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.1.100', hooks_applied: true });
            if (kind === 'new-minor') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.2.0', hooks_applied: true });
            if (kind === 'new-major') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '3.0.0', hooks_applied: true });
            if (kind === 'overlay-refused') f.controls.applyFlagSettings.mockRejectedValue(new Error(TOKEN));
            if (kind === 'managed-override') f.controls.applyFlagSettings.mockImplementation(async () => {});
            if (kind === 'restricted-org') f.restrictOrganization();
            if (kind === 'wrong-account') f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'bedrock', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } });
            const abortController = new AbortController(); if (kind === 'aborted') abortController.abort();
            const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options: { ...options, abortController } }, TOKEN);
            await expect(q.next()).rejects.toThrow(kind === 'aborted' ? 'Claude request aborted' : 'CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
            expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
        },
    );
    it('rechecks later input instead of trusting the initialization snapshot', async () => {
        const f = fixture();
        async function* prompt() { for (const content of ['one', 'two']) yield { type: 'user' as const, parent_tool_use_id: null, message: { role: 'user' as const, content } }; }
        const q = queryWithPinnedCredential(f.create as never, { prompt: prompt(), options }, TOKEN);
        await q.next(); f.tamper();
        await expect(q.next()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.received).toHaveLength(1);
    });
    it('preserves an authority refusal from the trusted input producer', async () => {
        const f = fixture(); const refusal = new Error('trusted authority refusal');
        async function* prompt(): AsyncGenerator<SDKUserMessage> { throw refusal; }
        const q = queryWithPinnedCredential(f.create as never, { prompt: prompt(), options }, TOKEN);
        await expect(q.next()).rejects.toBe(refusal);
        expect(f.received).toEqual([]);
    });
    it('checks side-question control requests and refuses a later auth change', async () => {
        const f = fixture(); const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        await q.next();
        const request = (q as unknown as {request(body: unknown): Promise<unknown>}).request;
        await request({ subtype: 'side_question', prompt: 'one' });
        expect(f.controls.request).toHaveBeenCalledOnce(); f.tamper();
        await expect(request({ subtype: 'side_question', prompt: 'two' })).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        expect(f.controls.request).toHaveBeenCalledOnce();
    });
    it.each(['missing-control', 'restricted-org', 'later-change'])('refuses organization %s with a source-specific sanitized error', async kind => {
        const f = fixture();
        if (kind === 'missing-control') f.controls.getSettings = undefined as never;
        if (kind === 'restricted-org') f.restrictOrganization();
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        if (kind === 'later-change') { await q.next(); f.tamper(); }
        if (kind === 'later-change') await expect((q as unknown as {request(body: unknown): Promise<unknown>}).request({ subtype: 'side_question' })).rejects.toThrow('CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED');
        else await expect(q.next()).rejects.toThrow('CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED');
        expect(f.received).toHaveLength(kind === 'later-change' ? 1 : 0);
        expect(f.controls.close).toHaveBeenCalled();
    });
    it('bounds a hung control call without sending input', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.getSettings.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        const checked = expect(q.next()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        await vi.advanceTimersByTimeAsync(10_001); await checked;
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });
    // A slow SessionStart hook delays initialization only; no input exists until it resolves.
    it('waits past the control timeout for Claude Code to finish starting', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.initializationResult.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ claude_code_version: '2.1.308', hooks_applied: true }), 12_000)));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        const first = q.next();
        await vi.advanceTimersByTimeAsync(12_001);
        await expect(first).resolves.toMatchObject({ done: false });
        expect(f.received).toHaveLength(1);
    });
    it('refuses without input when Claude Code does not finish starting within the startup budget', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        let settled = false;
        const checked = q.next().then(() => { throw new Error('unexpected input'); }, (error: unknown) => { settled = true; return error; });
        await vi.advanceTimersByTimeAsync(59_000); expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1_001);
        const error = await checked;
        expect(error).toMatchObject({ message: 'CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED', stage: 'initialize', reason: 'timeout' });
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });
    it('ends a startup wait as an abort when the user stops', async () => {
        vi.useFakeTimers(); const f = fixture(); const abortController = new AbortController();
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options: { ...options, abortController } }, TOKEN, 'organization');
        const checked = expect(q.next()).rejects.toThrow('Claude request aborted');
        await vi.advanceTimersByTimeAsync(15_000); abortController.abort(); await checked;
        expect(f.received).toEqual([]);
    });
    it('logs startup hook timing and the refused stage without hook output or credentials', async () => {
        vi.useFakeTimers(); const f = fixture(); const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        f.controls.initializationResult.mockImplementation(() => new Promise(() => {}));
        const hook = { type: 'system', hook_event: 'SessionStart', hook_id: 'h1', hook_name: 'SessionStart:startup' };
        const create = vi.fn(({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => Object.assign((async function* () {
            // Like the SDK, consume input on its own while the output stream reports hooks.
            void (async () => { try { for await (const message of prompt) f.received.push(message); } catch { /* refused */ } })();
            yield { ...hook, subtype: 'hook_started' };
            await new Promise(resolve => setTimeout(resolve, 7_000));
            yield { ...hook, subtype: 'hook_response', outcome: 'success', output: TOKEN, stdout: TOKEN, stderr: '' };
            await new Promise(() => {});
        })(), f.controls) as unknown as Query);
        const q = queryWithPinnedCredential(create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        await q.next();
        const second = q.next();
        await vi.advanceTimersByTimeAsync(7_001); await second;
        const third = q.next().catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(60_000); await third;
        const lines = debug.mock.calls.map(call => call.join(' ')).join('\n');
        expect(lines).toMatch(/SessionStart:startup hook started at \+\d+ms/);
        expect(lines).toMatch(/SessionStart:startup hook success at \+7\d{3}ms after 7\d{3}ms/);
        expect(lines).toMatch(/organization credential refused: stage=initialize reason=timeout after 6\d{4}ms/);
        expect(lines).not.toContain(TOKEN);
    });
    it.each([
        ['getSettings-hang', 'settings', 'timeout'],
        ['apply-hang', 'apply', 'timeout'],
        ['recheck-hang', 'recheck', 'timeout'],
        ['missing-control', 'initialize', 'unsupported'],
        ['old-version', 'initialize', 'unsupported'],
        ['overlay-refused', 'apply', 'control_failed'],
        ['managed-override', 'recheck', 'mismatch'],
        ['wrong-account', 'recheck', 'mismatch'],
        ['restricted-org', 'recheck', 'policy'],
    ])('reports %s as stage %s / reason %s without upstream detail', async (kind, stage, reason) => {
        vi.useFakeTimers(); const f = fixture();
        if (kind === 'getSettings-hang') f.controls.getSettings.mockImplementation(() => new Promise(() => {}));
        if (kind === 'apply-hang') f.controls.applyFlagSettings.mockImplementation(() => new Promise(() => {}));
        if (kind === 'recheck-hang') f.controls.reinitialize.mockImplementation(() => new Promise(() => {}));
        if (kind === 'missing-control') f.controls.applyFlagSettings = undefined as never;
        if (kind === 'old-version') f.controls.initializationResult.mockResolvedValue({ claude_code_version: '2.1.100', hooks_applied: true });
        if (kind === 'overlay-refused') f.controls.applyFlagSettings.mockRejectedValue(new Error(TOKEN));
        if (kind === 'managed-override') f.controls.applyFlagSettings.mockImplementation(async () => {});
        if (kind === 'wrong-account') f.controls.reinitialize.mockResolvedValue({ account: { apiProvider: 'bedrock', tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN' } });
        if (kind === 'restricted-org') f.restrictOrganization();
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN, 'organization');
        const checked = q.next().then(() => { throw new Error('unexpected input'); }, (error: unknown) => error);
        await vi.advanceTimersByTimeAsync(10_001);
        const error = await checked as Error & { stage?: string; reason?: string };
        expect(error).toMatchObject({ message: 'CLAUDE_ORGANIZATION_AUTH_NOT_VERIFIED', stage, reason });
        expect(JSON.stringify({ ...error, message: error.message })).not.toContain(TOKEN);
        expect(f.received).toEqual([]);
    });
});
