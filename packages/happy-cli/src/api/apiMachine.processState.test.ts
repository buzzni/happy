import { describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ApiMachineClient } from './apiMachine';
import { decodeBase64, decrypt, encodeBase64, encrypt } from './encryption';
import type { DaemonState, Machine } from './types';

/** Exercise the encrypted state publication boundary, including the server's CAS conflict. */
describe('daemon process identity publication', () => {
    it.each(['legacy', 'dataKey'] as const)('keeps its own decryptable key and control port across a %s state conflict', async (variant) => {
        const current = nacl.box.keyPair();
        const previous = nacl.box.keyPair();
        const own: DaemonState = { status: 'offline', pid: process.pid, httpPort: 2222, startedAt: 2000, mcpCallerGrantPublicKey: encodeBase64(current.publicKey) };
        const old: DaemonState = { status: 'shutting-down', pid: 111, httpPort: 1111, startedAt: 1000, mcpCallerGrantPublicKey: encodeBase64(previous.publicKey), shutdownSource: 'cli' };
        const machine: Machine = { id: 'test-machine', metadata: { host: 'localhost', platform: 'darwin', happyCliVersion: 'test', homeDir: '/tmp', happyHomeDir: '/tmp', happyLibDir: '/tmp' }, metadataVersion: 0, daemonState: old, daemonStateVersion: 9, encryptionKey: nacl.randomBytes(32), encryptionVariant: variant };
        const client = new ApiMachineClient('test-token', machine, undefined, undefined, own);
        const published: DaemonState[] = [];
        const emitWithAck = vi.fn(async (_event: string, request: { daemonState: string; expectedVersion: number }) => {
            published.push(decrypt(machine.encryptionKey, variant, decodeBase64(request.daemonState)) as DaemonState);
            if (published.length === 1) return { result: 'version-mismatch', version: 10, daemonState: encodeBase64(encrypt(machine.encryptionKey, variant, old)) };
            expect(request.expectedVersion).toBe(published.length === 2 ? 10 : 11);
            return { result: 'success', version: request.expectedVersion + 1, daemonState: request.daemonState };
        });
        Object.assign(client, { socket: { emitWithAck } });
        await client.updateDaemonState(state => ({ ...state!, status: 'running' }));
        await client.updateDaemonState(state => ({ ...state!, status: 'running', activity: { activeSessionCount: 1, activeAutomationCount: 0, reportedAt: 3000 } }));
        expect(published).toHaveLength(3);
        for (const state of published) {
            const sender = nacl.box.keyPair();
            const nonce = nacl.randomBytes(24);
            const plaintext = new TextEncoder().encode('synthetic-grant');
            const envelope = nacl.box(plaintext, nonce, decodeBase64(state.mcpCallerGrantPublicKey!), sender.secretKey);
            expect(nacl.box.open(envelope, nonce, sender.publicKey, current.secretKey)).toEqual(plaintext);
            expect(state).toMatchObject({ pid: process.pid, httpPort: 2222, startedAt: 2000 });
        }
        expect(published[2].activity?.activeSessionCount).toBe(1);
        expect(published[1].shutdownSource).toBe('cli');
    });
});
