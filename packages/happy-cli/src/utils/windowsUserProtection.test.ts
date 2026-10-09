import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
const fixture = vi.hoisted(() => ({ run: vi.fn(), stat: vi.fn(), read: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: fixture.run }));
vi.mock('node:fs', () => ({ lstatSync: fixture.stat, readFileSync: fixture.read }));
vi.mock('node:os', () => ({ platform: () => 'win32' }));
import { createWindowsUserProtection } from './windowsUserProtection';

const helper = Buffer.from('owned-test-helper');
const options = { helperPath: 'C:\\Saycode\\credential-protection.exe', helperSha256: createHash('sha256').update(helper).digest('hex') };
const secret = Buffer.from('fixture-token-never-in-argv-or-errors');
const purpose = 'saycode-private-v1:fixture';
const blob = Buffer.alloc(96, 0);
blob.writeUInt32LE(1, 0);
beforeEach(() => {
    vi.clearAllMocks();
    fixture.read.mockReturnValue(helper);
    fixture.stat.mockReturnValue({ isFile: () => true, isSymbolicLink: () => false, nlink: 1, size: helper.length });
    fixture.run.mockReturnValue({ status: 0, stdout: JSON.stringify({ version: 1, ok: true, value: blob.toString('base64') }) });
});
describe('Windows current-user protection transport', () => {
    it('uses only a private stdin pipe for secrets and verifies the selected helper', () => {
        expect(createWindowsUserProtection(options).protect(secret, purpose)).toEqual(blob);
        const [path, args, invocation] = fixture.run.mock.calls[0];
        expect(path).toBe(options.helperPath);
        expect(args).toEqual([]);
        expect(invocation.shell).toBe(false);
        expect(invocation.timeout).toBe(15000);
        expect(invocation.stdio).toEqual(['pipe', 'pipe', 'pipe']);
        expect(invocation).not.toHaveProperty('env');
        expect(JSON.parse(invocation.input.toString())).toEqual({ version: 1, operation: 'protect', purpose, value: secret.toString('base64') });
    });
    it('returns the exact plaintext only to the caller', () => {
        fixture.run.mockReturnValue({ status: 0, stdout: JSON.stringify({ version: 1, ok: true, value: secret.toString('base64') }) });
        expect(createWindowsUserProtection(options).unprotect(blob, purpose)).toEqual(secret);
    });
    it.each([
        { status: 1, stdout: 'fixture-token-never-in-argv-or-errors', stderr: secret.toString() },
        { status: null, error: Object.assign(new Error(secret.toString()), { code: 'EPERM' }) },
        { status: null, error: Object.assign(new Error(secret.toString()), { code: 'ETIMEDOUT' }) },
        { status: 0, stdout: JSON.stringify({ version: 1, ok: false, error: secret.toString() }) },
        { status: 0, stdout: JSON.stringify({ version: 2, ok: true, value: secret.toString('base64') }) },
    ])('throws a safe failure without a plaintext fallback', result => {
        fixture.run.mockReturnValue(result);
        expect(() => createWindowsUserProtection(options).protect(secret, purpose)).toThrow(/^WINDOWS_SECRET_PROTECTION_FAILED$/);
    });
    it('refuses an unexpected helper before sending a secret', () => {
        fixture.read.mockReturnValue(Buffer.from('different-helper'));
        expect(() => createWindowsUserProtection(options).protect(secret, purpose)).toThrow('WINDOWS_SECRET_HELPER_INVALID');
        expect(fixture.run).not.toHaveBeenCalled();
    });
    it('refuses a linked helper', () => {
        fixture.stat.mockReturnValue({ isFile: () => true, isSymbolicLink: () => true, nlink: 1, size: 1 });
        expect(() => createWindowsUserProtection(options).protect(secret, purpose)).toThrow('WINDOWS_SECRET_HELPER_INVALID');
        expect(fixture.run).not.toHaveBeenCalled();
    });
    it('never decrypts machine-scope blobs', () => {
        const machine = Buffer.from(blob); machine.writeUInt32LE(4, 40);
        expect(() => createWindowsUserProtection(options).unprotect(machine, purpose)).toThrow('WINDOWS_SECRET_INVALID_CIPHERTEXT');
        expect(fixture.run).not.toHaveBeenCalled();
    });
    it('refuses oversized input and a missing purpose', () => {
        expect(() => createWindowsUserProtection(options).protect(Buffer.alloc(8 * 1024 * 1024 + 1), purpose)).toThrow('WINDOWS_SECRET_INVALID_INPUT');
        expect(() => createWindowsUserProtection(options).protect(secret, '')).toThrow('WINDOWS_SECRET_INVALID_INPUT');
        expect(fixture.run).not.toHaveBeenCalled();
    });
});
