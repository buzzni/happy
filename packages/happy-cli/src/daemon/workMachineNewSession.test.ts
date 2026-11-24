import { beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import type { Credentials } from '@/persistence';
import { decodeReconnectSessionSnapshot, RECONNECT_FRESH_LAUNCH_ENV } from './reconnectSessionEnv';
import { prepareWorkMachineNewSession, startsNewWorkMachineConversation } from './workMachineNewSession';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('axios', () => ({ default: { post, isAxiosError: () => false }, isAxiosError: () => false }));
vi.mock('@/ui/logger', () => ({ logger: { debug: vi.fn(), warn: vi.fn() } }));

const encryption = { type: 'dataKey' as const, publicKey: nacl.box.keyPair().publicKey, machineKey: new Uint8Array(32).fill(7) };
const deviceCredentials: Credentials = { token: 'wmx_device-daemon', encryption };
const metadata = { path: '/work/project', host: 'pc', homeDir: '/home/me', happyHomeDir: '/home/me/.happy', happyLibDir: '/lib', happyToolsDir: '/tools' };

describe('prepareWorkMachineNewSession', () => {
    beforeEach(() => {
        post.mockReset();
        post.mockImplementation(async (_url: string, body: { metadata: string; dataEncryptionKey: string }) => ({ data: { session: {
            id: 'created-on-work-machine', seq: 0, metadata: body.metadata, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        } } }));
    });

    it('creates a protected machine conversation with the device daemon credential and hands the child a fresh attach', async () => {
        const persist = vi.fn(async () => true);
        const result = await prepareWorkMachineNewSession({
            protectedMachine: true, options: {}, credentials: deviceCredentials, metadata, persist,
        });

        expect(post).toHaveBeenCalledTimes(1);
        const [url, body, config] = post.mock.calls[0];
        expect(url).toMatch(/\/v1\/sessions$/);
        expect(config.headers.Authorization).toBe('Bearer wmx_device-daemon');
        expect(body).not.toHaveProperty('ownershipProof');
        expect(body).not.toHaveProperty('executionProof');
        if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
        expect(persist).toHaveBeenCalledWith(expect.objectContaining({ id: 'created-on-work-machine', encryptionVariant: 'dataKey' }));
        expect(result.environment.HAPPY_RECONNECT_SESSION_ID).toBe('created-on-work-machine');
        expect(result.environment[RECONNECT_FRESH_LAUNCH_ENV]).toBe('1');
        expect(decodeReconnectSessionSnapshot(result.environment.HAPPY_RECONNECT_SNAPSHOT)).toMatchObject({ metadata: { path: '/work/project' }, seq: 0 });
    });

    it('leaves an unprotected machine to the child, which creates the conversation with the account token', async () => {
        const persist = vi.fn(async () => true);
        const result = await prepareWorkMachineNewSession({
            protectedMachine: false, options: {}, credentials: { token: 'account-token', encryption }, metadata, persist,
        });

        expect(result).toEqual({ kind: 'unprotected' });
        expect(post).not.toHaveBeenCalled();
        expect(persist).not.toHaveBeenCalled();
    });

    it('never sends an account token for a protected machine', async () => {
        const result = await prepareWorkMachineNewSession({
            protectedMachine: true, options: {}, credentials: { token: 'account-token', encryption }, metadata, persist: async () => true,
        });

        expect(result.kind).toBe('refused');
        expect(post).not.toHaveBeenCalled();
    });

    it('refuses launches that continue another conversation instead of creating one', async () => {
        for (const options of [{ sessionId: 's' }, { resumeClaudeSessionId: 'c' }, { resumeCodexThreadId: 't' }, { parentSessionId: 'p' }]) {
            const result = await prepareWorkMachineNewSession({
                protectedMachine: true, options, credentials: deviceCredentials, metadata, persist: async () => true,
            });
            expect(result.kind).toBe('refused');
        }
        expect(post).not.toHaveBeenCalled();
    });

    // Medium 14: a spawn whose answer was lost is retried; it must land on the conversation it created.
    it('gives a retried spawn request the same tag and session key, and different requests their own', async () => {
        const spawn = async (initialPromptLocalId?: string) => {
            const result = await prepareWorkMachineNewSession({
                protectedMachine: true, options: initialPromptLocalId ? { initialPromptLocalId } : {}, credentials: deviceCredentials, metadata,
                persist: async () => true,
            });
            if (result.kind !== 'created') throw new Error(`expected created, got ${result.kind}`);
            return { tag: (post.mock.calls.at(-1)![1] as { tag: string }).tag, key: Buffer.from(result.session.encryptionKey).toString('hex') };
        };

        const first = await spawn('local-prompt-1');
        expect(await spawn('local-prompt-1')).toEqual(first);
        const other = await spawn('local-prompt-2');
        expect(other.tag).not.toBe(first.tag);
        expect(other.key).not.toBe(first.key);
        expect((await spawn()).tag).not.toBe((await spawn()).tag);
    });

    it('refuses to start when the created conversation is not durably recorded', async () => {
        const result = await prepareWorkMachineNewSession({
            protectedMachine: true, options: {}, credentials: deviceCredentials, metadata, persist: async () => false,
        });

        expect(result.kind).toBe('refused');
    });

    it('names the migration drain when the server pauses new work on the machine', async () => {
        post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Work machine is draining', reason: 'work-machine-draining' } } });

        const result = await prepareWorkMachineNewSession({
            protectedMachine: true, options: {}, credentials: deviceCredentials, metadata, persist: async () => true,
        });

        expect(result).toEqual({
            kind: 'refused',
            errorMessage: 'This work machine is being migrated; new work is paused until the migration finishes',
        });
    });

    it('keeps the reachability hint for a refusal that is not a drain', async () => {
        post.mockRejectedValueOnce({ response: { status: 403, data: { error: 'Work machine device authorization required' } } });

        const result = await prepareWorkMachineNewSession({
            protectedMachine: true, options: {}, credentials: deviceCredentials, metadata, persist: async () => true,
        });

        expect(result).toEqual({
            kind: 'refused',
            errorMessage: 'Work machine conversation could not be created; retry when the server is reachable',
        });
    });
});

describe('startsNewWorkMachineConversation', () => {
    it('starts the provider fresh only for a daemon-created conversation without a provider session', () => {
        expect(startsNewWorkMachineConversation(true, undefined)).toBe(true);
        // A recorded provider session must resume; a lost transcript is never replaced by an empty conversation.
        expect(startsNewWorkMachineConversation(true, 'claude-session')).toBe(false);
        expect(startsNewWorkMachineConversation(false, undefined)).toBe(false);
    });
});
