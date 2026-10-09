/**
 * aplus-dev-studio specs/e2ee-machine-control-boundary 4b-3 preview stage 2 — the daemon starts a
 * preview with the env the server sealed for it, after checking what it opened.
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveServerRpcKey } from '@/api/encryption';
import { createSealedSpawnEnvHandler, openSealedSpawnEnv, sealSpawnEnv } from './sealedSpawnEnv';

const machineKey = new Uint8Array(32).fill(3);
const laneKey = deriveServerRpcKey(machineKey);
const now = 1_790_000_000_000;
let nonceCounter = 0;
const freshNonce = () => Buffer.alloc(16, ++nonceCounter).toString('base64');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-spawn-env-')));

function sealed(over: Record<string, unknown> = {}, key: Uint8Array = laneKey): string {
  return sealSpawnEnv(key, {
    v: 1, purpose: 'spawn-env', machineId: 'machine-1', projectId: 'p1', issuedAt: now, nonce: freshNonce(),
    env: { API_KEY: 'secret-value', DATABASE_URL: 'postgres://db' },
    ...over,
  } as never);
}

function handler(machine: Partial<{ id: string; encryptionKey: Uint8Array; encryptionVariant: 'legacy' | 'dataKey' }> = {}) {
  return createSealedSpawnEnvHandler({
    machine: () => ({ id: 'machine-1', encryptionKey: machineKey, encryptionVariant: 'dataKey', ...machine }),
    allowedRoot: root,
    now: () => now,
  });
}

describe('openSealedSpawnEnv', () => {
  it('opens what the server sealed with the lane key', () => {
    const value = openSealedSpawnEnv(machineKey, sealed());
    expect(value).toMatchObject({ purpose: 'spawn-env', env: { API_KEY: 'secret-value' } });
  });

  it('does not open a payload sealed with the lane key itself, so it cannot pass as a server-lane request', () => {
    // The seal key is derived from the lane key with its own label.
    expect(openSealedSpawnEnv(new Uint8Array(32).fill(4), sealed())).toBeNull();
    expect(openSealedSpawnEnv(machineKey, 'not-base64!')).toBeNull();
  });
});

describe('spawn-with-sealed-env', () => {
  it('runs the command with the opened env as process env, not as command text', async () => {
    const result = await handler()({ command: 'printf %s "$API_KEY"', cwd: root, sealedEnv: sealed(), envDelivery: 'process' });
    expect(result).toMatchObject({ success: true, stdout: 'secret-value', exitCode: 0 });
  });

  it('writes the env to a 0600 file for a file delivery and removes it after the command', async () => {
    const script = "node -e \"const f=process.env.APLUS_SEALED_ENV_FILE;const fs=require('fs');process.stdout.write([f,(fs.statSync(f).mode&0o777).toString(8),fs.readFileSync(f,'utf8')].join('|'))\"";
    const result = await handler()({ command: script, cwd: root, sealedEnv: sealed(), envDelivery: 'file' });
    expect(result.success).toBe(true);
    const [file, mode, content] = String(result.stdout).split('|');
    expect(mode).toBe('600');
    expect(content).toBe('API_KEY=secret-value\nDATABASE_URL=postgres://db');
    expect(existsSync(file!)).toBe(false);
  });

  it('kills descendants when a command times out', async () => {
    const result = await handler()({
      command: 'sleep 20 & echo $!; wait', cwd: root, sealedEnv: sealed(), envDelivery: 'process', timeout: 100,
    });
    expect(result).toMatchObject({ success: false, error: 'Command timed out' });
    const pid = Number(String(result.stdout).trim().split(/\s+/)[0]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('refuses a reserved name and runs nothing', async () => {
    const result = await handler()({
      command: 'echo ran', cwd: root, envDelivery: 'process',
      sealedEnv: sealed({ env: { API_KEY: 'k', NODE_OPTIONS: '--require /tmp/x.js' } }),
    });
    expect(result).toMatchObject({ success: false, errorCode: 'SEALED_ENV_RESERVED_NAME', rejectedNames: ['NODE_OPTIONS'] });
    expect(result.stdout).toBe('');
  });

  it('refuses a payload it cannot open, one for another machine, a stale one and a replayed one', async () => {
    const run = handler();
    const base = { command: 'echo ran', cwd: root, envDelivery: 'process' as const };
    expect(await run({ ...base, sealedEnv: sealed({}, new Uint8Array(32).fill(9)) })).toMatchObject({ success: false, errorCode: 'SEALED_ENV_UNREADABLE' });
    expect(await run({ ...base, sealedEnv: sealed({ machineId: 'machine-2' }) })).toMatchObject({ success: false, errorCode: 'SEALED_ENV_MACHINE_MISMATCH' });
    expect(await run({ ...base, sealedEnv: sealed({ issuedAt: now - 10 * 60_000 }) })).toMatchObject({ success: false, errorCode: 'SEALED_ENV_STALE' });
    const once = sealed();
    expect(await run({ ...base, sealedEnv: once })).toMatchObject({ success: true });
    expect(await run({ ...base, sealedEnv: once })).toMatchObject({ success: false, errorCode: 'SEALED_ENV_REPLAYED' });
  });

  it('refuses on a machine without a machine key', async () => {
    const result = await handler({ encryptionVariant: 'legacy' })({ command: 'echo ran', cwd: root, sealedEnv: sealed(), envDelivery: 'process' });
    expect(result).toMatchObject({ success: false, errorCode: 'SEALED_ENV_UNSUPPORTED' });
  });

  it('refuses a cwd outside the allowed root and a malformed request', async () => {
    const run = handler();
    expect(await run({ command: 'echo ran', cwd: '/', sealedEnv: sealed(), envDelivery: 'process' })).toMatchObject({ success: false });
    expect(await run({ command: 'echo ran', cwd: root, sealedEnv: sealed(), envDelivery: 'shell' as never })).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
    expect(await run({ cwd: root } as never)).toMatchObject({ success: false, errorCode: 'INVALID_REQUEST' });
  });
});
