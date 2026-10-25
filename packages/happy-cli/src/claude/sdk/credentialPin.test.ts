import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { queryWithPinnedCredential } from './credentialPin';
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
afterEach(() => vi.useRealTimers());
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
    it('bounds a hung control call without sending input', async () => {
        vi.useFakeTimers(); const f = fixture();
        f.controls.getSettings.mockImplementation(() => new Promise(() => {}));
        const q = queryWithPinnedCredential(f.create as never, { prompt: 'hello', options }, TOKEN);
        const checked = expect(q.next()).rejects.toThrow('CLAUDE_PERSONAL_AUTH_NOT_VERIFIED');
        await vi.advanceTimersByTimeAsync(10_001); await checked;
        expect(f.received).toEqual([]); expect(f.controls.close).toHaveBeenCalled();
    });
});
