import { test } from 'vitest';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyRequest, runUpgrade, consumeStart } from './abp-runtime-update.mjs';
const pair = generateKeyPairSync('ed25519');
const config = { machineId: 'm', workspaceId: 'w', trustedIssuers: [{ kid: 'k', publicKeyPem: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }] };
const image = { ref: 'docker.io/buzzni/abp-runtime@sha256:' + 'a'.repeat(64), ids: { amd64: 'sha256:' + 'b'.repeat(64), arm64: 'sha256:' + 'c'.repeat(64) } };
const manifest = { schemaVersion: 1, version: '1.2.3', runtime: image, browser: image };
const claims = { kind: 'runtime-update', iss: 'saycode-server', aud: 'm', machineId: 'm', workspaceId: 'w', principalId: 'u', requestId: '12345678-1234-1234-1234-123456789abc', issuedAtMs: 1000, expiresAtMs: 61000, action: 'start', manifest };
function token(payload: Record<string, unknown> = claims, typ = 'abp-runtime-update') { const input = `abp2.${Buffer.from(JSON.stringify({ alg: 'EdDSA', kid: 'k', typ })).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`; return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`; }
test('accepts only a scoped, short lived dedicated update signature', () => {
    assert.equal(verifyRequest(token(), config, 2000).action, 'start');
    for (const patch of [{ machineId: 'other' }, { workspaceId: 'other' }, { aud: 'other' }, { expiresAtMs: 1000 }, { issuedAtMs: 32001, expiresAtMs: 92001 }, { expiresAtMs: 62000 }, { action: 'bash' }, { manifest: { ...manifest, runtime: { ...image, ref: 'https://evil/x' } } }])
        assert.throws(() => verifyRequest(token({ ...claims, ...patch }), config, 2000));
    assert.throws(() => verifyRequest(token(claims, 'abp-cap'), config, 2000));
    assert.throws(() => verifyRequest(token().slice(0, -8) + 'AAAAAAAA', config, 2000));
});
test('does not claim completion until target digests and readiness match', async () => {
    const calls: string[] = [];
    const deps = { upgrade: async () => calls.push('upgrade'), status: async () => ({ ok: true }), current: () => ({ runtime: image.ids.amd64, browser: image.ids.amd64 }) };
    assert.equal((await runUpgrade(manifest, 'x86_64', deps)).phase, 'complete');
    assert.deepEqual(calls, ['upgrade']);
    assert.equal((await runUpgrade(manifest, 'x86_64', { ...deps, current: () => ({}) })).phase, 'failed');
    assert.equal((await runUpgrade(manifest, 'x86_64', { ...deps, status: async () => ({ ok: false }) })).phase, 'failed');
});
test('failed upgrade remains failed even when previous stack recovers', async () => {
    const result = await runUpgrade(manifest, 'x86_64', { upgrade: async () => { throw Error('raw sensitive output'); }, status: async () => ({ ok: true }), current: () => ({}) });
    assert.deepEqual(result, { phase: 'failed', reason: 'upgrade-failed', recovered: true });
    assert.equal(JSON.stringify(result).includes('sensitive'), false);
});
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('persists replay protection and refuses concurrent updates', () => {
    const dir = mkdtempSync(join(tmpdir(), 'abp-update-test-'));
    try {
        assert.equal(consumeStart(claims, dir), true);
        assert.throws(() => consumeStart(claims, dir), /replayed/);
        assert.equal(consumeStart({ ...claims, requestId: '22345678-1234-1234-1234-123456789abc' }, dir), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('tolerates at most 30 seconds of issue-time skew without relaxing expiry or lifetime', () => {
    assert.equal(verifyRequest(token({ ...claims, issuedAtMs: 32000, expiresAtMs: 92000 }), config, 2000).action, 'start');
    assert.throws(() => verifyRequest(token({ ...claims, issuedAtMs: 32001, expiresAtMs: 92001 }), config, 2000));
    assert.throws(() => verifyRequest(token({ ...claims, expiresAtMs: 2000 }), config, 2000));
    assert.throws(() => verifyRequest(token({ ...claims, issuedAtMs: 32000, expiresAtMs: 92001 }), config, 2000));
});
test('accepts pinned index digests reported by the containerd image store', async () => {
    const deps = { upgrade: async () => {}, status: async () => ({ ok: true }), current: () => ({ runtime: image.ref.split('@')[1], browser: image.ref.split('@')[1] }) };
    assert.equal((await runUpgrade(manifest, 'arm64', deps)).phase, 'complete');
    assert.equal((await runUpgrade(manifest, 'arm64', { ...deps, current: () => ({ runtime: image.ref.split('@')[1], browser: 'sha256:' + 'd'.repeat(64) }) })).phase, 'failed');
});
