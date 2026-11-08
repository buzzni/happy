import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentDelegationStore, type AgentDelegationStore } from './agentDelegationStore';
import { delegationLaneAdmission, registerAgentDelegationRpc, type AgentDelegationHost } from './agentDelegationMethods';
import type { RpcCallContext } from '@/api/rpc/types';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');
const PEER: RpcCallContext = { lane: 'delegation', peer: 'machine-a' };

describe('agent-delegation RPCs', () => {
    let dir: string;
    let store: AgentDelegationStore;
    let handlers: Map<string, (params: unknown, context?: RpcCallContext) => any>;
    let spawn: ReturnType<typeof vi.fn>;
    let live: Set<string>;
    let existing: Set<string>;
    let afterSpawn: ReturnType<typeof vi.fn>;

    const setup = (host: Partial<AgentDelegationHost> = {}) => {
        handlers = new Map();
        registerAgentDelegationRpc((method, handler) => handlers.set(method, handler), {
            store,
            isSessionLive: (sessionId) => live.has(sessionId),
            readSessionKey: (sessionId) => sessionId === 'legacy-child' ? { variant: 'legacy' } : { variant: 'dataKey', key: key(9) },
            concurrencyLimit: 2,
            directoryExists: async (path) => existing.has(path),
            ...host,
        }, { spawn: spawn as never, afterSpawn: afterSpawn as never });
    };
    const call = (method: string, params: unknown, context?: RpcCallContext) => handlers.get(method)!(params, context);
    const spawnRequest = (overrides: Record<string, unknown> = {}) => ({
        parentSessionId: 'parent-1',
        directory: '/work/app',
        agent: 'claude',
        initialPrompt: 'run the tests',
        agentGrant: { depth: 1, maxSpawn: 4, agentId: 'child-agent' },
        ...overrides,
    });

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'delegation-methods-'));
        store = createAgentDelegationStore({ path: join(dir, 'agent-delegation.json') });
        await store.installTarget({ sourceMachineId: 'machine-a', keyId: 'k1', key: key(1), createdBy: { accountId: 'linker', displayName: 'Lee' } });
        spawn = vi.fn(async () => ({ type: 'success', sessionId: 'child-1' }));
        afterSpawn = vi.fn();
        live = new Set();
        existing = new Set(['/work/app']);
        setup();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('starts the child with an environment built here, the linker as creator and the parent recorded', async () => {
        const reply = await call('agent-delegation:spawn', spawnRequest({ model: 'opus', effort: 'high' }), PEER);
        expect(reply).toEqual({ type: 'success', sessionId: 'child-1' });
        expect(spawn).toHaveBeenCalledWith({
            directory: '/work/app',
            agent: 'claude',
            model: 'opus',
            effort: 'high',
            initialPrompt: 'run the tests',
            environmentVariables: {
                SAYCODE_AGENT_ENV: '1',
                SAYCODE_AGENT_ROOT: '/work/app',
                SAYCODE_AGENT_SCOPE: '/work/app',
                SAYCODE_AGENT_DEPTH: '1',
                SAYCODE_AGENT_MAX_SPAWN: '4',
                SAYCODE_AGENT_ID: 'child-agent',
                SAYCODE_AGENT_DELEGATED_FROM: 'machine-a',
            },
            createdByAccountId: 'linker',
            createdByDisplayName: 'Lee',
            delegatedFrom: { machineId: 'machine-a', sessionId: 'parent-1' },
        });
        expect(store.childOf('child-1', 'machine-a')).toBe(true);
        expect(afterSpawn).toHaveBeenCalledWith({ sessionId: 'child-1', directory: '/work/app' });
    });

    it('refuses anything the requester tries to carry beyond the narrow request', async () => {
        for (const extra of [{ environmentVariables: { PATH: '/evil' } }, { happySecret: 'x' }, { token: 't' }, { approvedNewDirectoryCreation: true }]) {
            expect(await call('agent-delegation:spawn', spawnRequest(extra), PEER)).toMatchObject({ type: 'error', code: 'invalid_request' });
        }
        expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses a missing directory without creating it', async () => {
        expect(await call('agent-delegation:spawn', spawnRequest({ directory: '/work/missing' }), PEER)).toMatchObject({ code: 'project_not_found' });
        expect(await call('agent-delegation:spawn', spawnRequest({ directory: 'relative/path' }), PEER)).toMatchObject({ code: 'invalid_request' });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('refuses a child deeper than the ceiling', async () => {
        const reply = await call('agent-delegation:spawn', spawnRequest({ agentGrant: { depth: 3, maxSpawn: 0, agentId: 'a' } }), PEER);
        expect(reply).toMatchObject({ code: 'spawn_depth_exceeded' });
    });

    it('refuses when this machine already runs as many delegated children as it allows', async () => {
        await store.recordChild({ sessionId: 'c1', peer: 'machine-a', parentSessionId: 'p' });
        await store.recordChild({ sessionId: 'c2', peer: 'machine-x', parentSessionId: 'p' });
        await store.recordChild({ sessionId: 'c3', peer: 'machine-a', parentSessionId: 'p' });
        live = new Set(['c1', 'c2']);
        expect(await call('agent-delegation:spawn', spawnRequest(), PEER)).toMatchObject({ code: 'target_busy' });
        live = new Set(['c1']);
        expect(await call('agent-delegation:spawn', spawnRequest(), PEER)).toMatchObject({ type: 'success' });
    });

    it('answers a policy refusal by this machine as target_refused with its reason', async () => {
        spawn.mockRejectedValueOnce(new Error('Organization Claude approval required'));
        expect(await call('agent-delegation:spawn', spawnRequest(), PEER)).toEqual({ type: 'error', code: 'target_refused', errorMessage: 'Organization Claude approval required' });
        spawn.mockResolvedValueOnce({ type: 'error', errorMessage: 'sandbox refused' });
        expect(await call('agent-delegation:spawn', spawnRequest(), PEER)).toEqual({ type: 'error', code: 'target_refused', errorMessage: 'sandbox refused' });
        spawn.mockResolvedValueOnce({ type: 'error', code: 'daemon-restarting', errorMessage: 'restarting', deadlineAt: 5 });
        expect(await call('agent-delegation:spawn', spawnRequest(), PEER)).toEqual({ type: 'error', code: 'daemon-restarting', errorMessage: 'restarting', deadlineAt: 5 });
    });

    it('refuses a spawn that did not come through the delegation lane, and one whose link is gone', async () => {
        expect(await call('agent-delegation:spawn', spawnRequest())).toMatchObject({ code: 'delegation_lane_required' });
        expect(await call('agent-delegation:spawn', spawnRequest(), { lane: 'delegation', peer: 'machine-unknown' })).toMatchObject({ code: 'machine_not_delegatable' });
        expect(spawn).not.toHaveBeenCalled();
    });

    it('hands a session key only for the peer that started the session', async () => {
        await store.recordChild({ sessionId: 'child-1', peer: 'machine-a', parentSessionId: 'p' });
        await store.recordChild({ sessionId: 'legacy-child', peer: 'machine-a', parentSessionId: 'p' });
        expect(await call('agent-delegation:session-key', { sessionId: 'child-1' }, PEER)).toEqual({ type: 'success', sessionId: 'child-1', variant: 'dataKey', key: key(9) });
        expect(await call('agent-delegation:session-key', { sessionId: 'legacy-child' }, PEER)).toEqual({ type: 'success', sessionId: 'legacy-child', variant: 'legacy' });
        expect(await call('agent-delegation:session-key', { sessionId: 'child-1' }, { lane: 'delegation', peer: 'machine-c' })).toMatchObject({ code: 'session_not_found' });
        expect(await call('agent-delegation:session-key', { sessionId: 'someone-elses' }, PEER)).toMatchObject({ code: 'session_not_found' });
        expect(await call('agent-delegation:session-key', { sessionId: 'child-1' })).toMatchObject({ code: 'session_not_found' });
    });

    it('lets the lane stop only the peer’s own children', async () => {
        await store.recordChild({ sessionId: 'child-1', peer: 'machine-a', parentSessionId: 'p' });
        const admit = delegationLaneAdmission(store);
        expect(admit('stop-session', { sessionId: 'child-1' }, 'machine-a')).toBeNull();
        expect(admit('stop-session', { sessionId: 'child-1' }, 'machine-c')).toMatchObject({ code: 'session_not_found' });
        expect(admit('stop-session', { sessionId: 'other' }, 'machine-a')).toMatchObject({ code: 'session_not_found' });
        expect(admit('stop-session', {}, 'machine-a')).toMatchObject({ code: 'session_not_found' });
        expect(admit('ai-credential:status', {}, 'machine-a')).toBeNull();
    });

    it('installs, lists without keys, serves targets with keys, and revokes', async () => {
        expect(await call('agent-delegation:install-source', { targetMachineId: 'machine-b', keyId: 'k2', key: key(2), name: 'GPU PC', platform: 'linux' })).toEqual({ ok: true });
        const listed = await call('agent-delegation:list', {});
        expect(listed).toMatchObject({ version: 1, asTarget: [{ sourceMachineId: 'machine-a' }], asSource: [{ targetMachineId: 'machine-b' }] });
        expect(JSON.stringify(listed)).not.toContain(key(2));
        expect(await call('agent-delegation:targets', {})).toEqual({ version: 1, targets: [{ targetMachineId: 'machine-b', keyId: 'k2', key: key(2), name: 'GPU PC', platform: 'linux' }] });
        expect(await call('agent-delegation:revoke', { role: 'target', peerMachineId: 'machine-a' })).toEqual({ removed: true });
        expect(store.laneLinks()).toEqual([]);
    });
});
