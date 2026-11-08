import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_DELEGATION_MAX_LINKS, createAgentDelegationStore } from './agentDelegationStore';

const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

describe('agent delegation store', () => {
    let dir: string;
    let path: string;
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'delegation-store-'));
        path = join(dir, 'agent-delegation.json');
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const target = (sourceMachineId: string, fill = 1) => ({
        sourceMachineId, keyId: `k${fill}`, key: key(fill), createdBy: { accountId: 'acct-1', displayName: 'Kim' },
    });
    const source = (targetMachineId: string, fill = 1) => ({
        targetMachineId, keyId: `k${fill}`, key: key(fill), name: 'Build PC', platform: 'win32',
    });

    it('starts empty when there is no file and writes it owner-only', async () => {
        const store = createAgentDelegationStore({ path, now: () => 100 });
        expect(store.list()).toEqual({ asTarget: [], asSource: [] });
        await store.installTarget(target('machine-a'));
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1);
    });

    it('survives a restart and serves the lane keys from what it read', async () => {
        await createAgentDelegationStore({ path, now: () => 100 }).installTarget(target('machine-a', 7));
        const reopened = createAgentDelegationStore({ path });
        expect(reopened.laneLinks()).toEqual([{ peer: 'machine-a', key: new Uint8Array(Buffer.alloc(32, 7)) }]);
        expect(reopened.targetLink('machine-a')).toMatchObject({ createdBy: { accountId: 'acct-1', displayName: 'Kim' } });
    });

    it('replaces the link for the same peer (key rotation) instead of adding one', async () => {
        const store = createAgentDelegationStore({ path });
        await store.installTarget(target('machine-a', 1));
        await store.installTarget(target('machine-a', 2));
        expect(store.laneLinks()).toEqual([{ peer: 'machine-a', key: new Uint8Array(Buffer.alloc(32, 2)) }]);
    });

    it('keeps both of two installs that arrive together', async () => {
        const store = createAgentDelegationStore({ path });
        await Promise.all([store.installTarget(target('machine-a', 1)), store.installTarget(target('machine-c', 2)), store.installSource(source('machine-b', 3))]);
        const reopened = createAgentDelegationStore({ path });
        expect(reopened.laneLinks().map((link) => link.peer).sort()).toEqual(['machine-a', 'machine-c']);
        expect(reopened.sourceLinks()).toHaveLength(1);
    });

    it('never lists a key', async () => {
        const store = createAgentDelegationStore({ path, now: () => 5 });
        await store.installTarget(target('machine-a', 3));
        await store.installSource(source('machine-b', 4));
        expect(JSON.stringify(store.list())).not.toContain(key(3));
        expect(JSON.stringify(store.list())).not.toContain(key(4));
        expect(store.list()).toEqual({
            asTarget: [{ sourceMachineId: 'machine-a', keyId: 'k3', createdBy: { accountId: 'acct-1', displayName: 'Kim' }, createdAt: 5 }],
            asSource: [{ targetMachineId: 'machine-b', keyId: 'k4', name: 'Build PC', platform: 'win32', createdAt: 5 }],
        });
    });

    it('hands the source links with keys only through sourceLinks', async () => {
        const store = createAgentDelegationStore({ path, now: () => 5 });
        await store.installSource(source('machine-b', 4));
        expect(store.sourceLinks()).toEqual([{ targetMachineId: 'machine-b', keyId: 'k4', key: key(4), name: 'Build PC', platform: 'win32' }]);
    });

    it('drops the lane key at once on revoke but keeps the children it started, which may still run', async () => {
        const store = createAgentDelegationStore({ path });
        await store.installTarget(target('machine-a'));
        await store.recordChild({ sessionId: 's1', peer: 'machine-a', parentSessionId: 'p1' });
        expect(await store.revoke('target', 'machine-a')).toEqual({ removed: true });
        expect(store.laneLinks()).toEqual([]);
        // Unreachable without the key; still counted against the limit while it runs.
        expect(store.children().map((child) => child.sessionId)).toEqual(['s1']);
        expect(createAgentDelegationStore({ path }).laneLinks()).toEqual([]);
        expect(await store.revoke('target', 'machine-a')).toEqual({ removed: false });
    });

    it('refuses a new peer past the limit but still rotates an existing one', async () => {
        const store = createAgentDelegationStore({ path });
        for (let i = 0; i < AGENT_DELEGATION_MAX_LINKS; i++) await store.installTarget(target(`machine-${i}`, i + 1));
        await expect(store.installTarget(target('machine-new', 99))).rejects.toThrow(/limit/);
        await store.installTarget(target('machine-0', 50));
        expect(store.laneLinks()).toHaveLength(AGENT_DELEGATION_MAX_LINKS);
    });

    it('rejects a malformed key or id before writing anything', async () => {
        const store = createAgentDelegationStore({ path });
        await expect(store.installTarget({ ...target('machine-a'), key: 'short' })).rejects.toThrow();
        await expect(store.installTarget({ ...target(''), })).rejects.toThrow();
        await expect(store.installSource({ ...source('machine-b'), platform: '' })).rejects.toThrow();
        expect(() => statSync(path)).toThrow();
    });

    it('remembers which peer created a child and answers only for that peer', async () => {
        const store = createAgentDelegationStore({ path });
        await store.recordChild({ sessionId: 's1', peer: 'machine-a', parentSessionId: 'p1' });
        expect(store.childOf('s1', 'machine-a')).toBe(true);
        expect(store.childOf('s1', 'machine-c')).toBe(false);
        expect(store.childOf('s2', 'machine-a')).toBe(false);
        expect(createAgentDelegationStore({ path }).children()).toEqual([expect.objectContaining({ sessionId: 's1', peer: 'machine-a', parentSessionId: 'p1' })]);
    });

    it('forgets finished children first and never a running one', async () => {
        const store = createAgentDelegationStore({ path });
        await store.recordChild({ sessionId: 'long-runner', peer: 'machine-a', parentSessionId: 'p' });
        for (let i = 0; i < 260; i++) await store.recordChild({ sessionId: `s${i}`, peer: 'machine-a', parentSessionId: 'p' }, (id) => id === 'long-runner');
        expect(store.children()).toHaveLength(256);
        expect(store.childOf('long-runner', 'machine-a')).toBe(true);
        expect(store.childOf('s0', 'machine-a')).toBe(false);
    });

    it('claims a spawn request id once, across a restart, and forgets it after the window', async () => {
        let clock = 1_000;
        const store = createAgentDelegationStore({ path, now: () => clock });
        expect(await store.claimRequest('machine-a', 'r1')).toBe(true);
        expect(await store.claimRequest('machine-a', 'r1')).toBe(false);
        expect(await store.claimRequest('machine-c', 'r1')).toBe(true);
        expect(await createAgentDelegationStore({ path, now: () => clock }).claimRequest('machine-a', 'r1')).toBe(false);
        clock += 16 * 60_000;
        expect(await createAgentDelegationStore({ path, now: () => clock }).claimRequest('machine-a', 'r1')).toBe(true);
    });

    it('reads an unreadable or foreign file as empty rather than trusting part of it', () => {
        writeFileSync(path, '{"version":2,"asTarget":[{"sourceMachineId":"x"}]}');
        expect(createAgentDelegationStore({ path }).laneLinks()).toEqual([]);
        writeFileSync(path, 'not json');
        expect(createAgentDelegationStore({ path }).list()).toEqual({ asTarget: [], asSource: [] });
    });
});
