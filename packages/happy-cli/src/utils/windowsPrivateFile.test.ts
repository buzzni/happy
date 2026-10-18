import { describe, expect, it, vi } from 'vitest';
vi.mock('node:os', () => ({ platform: () => 'win32' }));
import { createWindowsPrivateFileCodec, WindowsPrivateFileError } from './windowsPrivateFile';
const file = 'C:\\Users\\fixture\\home\\access.key';
const body = '{"token":"fixture-token","secret":"fixture-key"}';
function fixture(required: boolean) {
    const unprotect = vi.fn((_value: Buffer, _purpose: string) => Buffer.from(body));
    const protect = vi.fn((_value: Buffer, _purpose: string) => Buffer.from('opaque-fixture-cipher'));
    return { codec: createWindowsPrivateFileCodec(() => ({ protect, unprotect, readPrivateLegacy: vi.fn(), readProtectedFile: vi.fn(), publishProtectedFile: vi.fn(), writeProtectedFile: vi.fn(), prepareDirectory: vi.fn(), storageRoots: vi.fn() }), () => required), protect, unprotect };
}
describe('Windows private file compatibility boundary', () => {
    it('preserves legacy binary bytes and encrypts binary writes with a final-path binding', () => {
        const readProtectedFile = vi.fn(() => Buffer.from([0, 255, 128, 1]));
        const writeProtectedFile = vi.fn();
        const codec = createWindowsPrivateFileCodec(() => ({ readProtectedFile, writeProtectedFile }) as never);
        expect(codec.readBytes(file)).toEqual(Buffer.from([0, 255, 128, 1]));
        codec.writeBytes(file + '.tmp', Buffer.from([0, 255, 128, 1]), file, true);
        expect(writeProtectedFile).toHaveBeenCalledWith(file + '.tmp', 'saycode-binary-v1:AP+AAQ==', 'saycode-dpapi-v1:' + file.toLowerCase(), true);
        readProtectedFile.mockImplementation(() => Buffer.from('saycode-binary-v1:AP+AAQ=='));
        expect(codec.readBytes(file)).toEqual(Buffer.from([0, 255, 128, 1]));
        readProtectedFile.mockImplementation(() => Buffer.from('saycode-binary-v1:invalid!'));
        expect(() => codec.readBytes(file)).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
    it('leaves unactivated legacy writes unchanged and does not load a helper', () => {
        const { codec, protect } = fixture(false);
        expect(codec.encode(body, file)).toBe(body);
        expect(codec.decode(body, file)).toBe(body);
        expect(protect).not.toHaveBeenCalled();
    });
    it('encrypts exact bytes and binds the logical target rather than a temporary filename', () => {
        const { codec, protect } = fixture(true);
        const encoded = codec.encode(body, file);
        expect(encoded).not.toContain('fixture-token');
        expect(JSON.parse(encoded).storage).toBe('saycode-dpapi-v1');
        expect(protect.mock.calls[0][1]).toBe('saycode-dpapi-v1:c:\\users\\fixture\\home\\access.key');
        expect(codec.decode(encoded, file)).toBe(body);
    });
    it('reads ciphertext even when new encrypted writes are not activated', () => {
        const encoded = fixture(true).codec.encode(body, file);
        expect(fixture(false).codec.decode(encoded, file)).toBe(body);
    });
    it('keeps an existing encrypted file encrypted when the activation flag is absent', () => {
        const encoded = fixture(true).codec.encode(body, file);
        expect(fixture(false).codec.encode(body, file, encoded)).not.toContain('fixture-token');
    });
    it('refuses unverified plaintext in required mode instead of accepting a replacement file', () => {
        expect(() => fixture(true).codec.decode(body, file)).toThrow('WINDOWS_SECRET_LEGACY_UNPROTECTED');
    });
    it('propagates a typed read failure for damaged ciphertext', () => {
        const { codec, unprotect } = fixture(true);
        unprotect.mockImplementation(() => { throw new Error(body); });
        expect(() => codec.decode(codec.encode(body, file), file)).toThrow(WindowsPrivateFileError);
        expect(() => codec.decode(codec.encode(body, file), file)).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
    it('never downgrades a failed encrypted write to plaintext', () => {
        const { codec, protect } = fixture(true);
        protect.mockImplementation(() => { throw new Error(body); });
        expect(() => codec.encode(body, file)).toThrow('WINDOWS_SECRET_WRITE_FAILED');
    });
    it('fails closed on an unknown envelope version', () => {
        expect(() => fixture(false).codec.decode('{"storage":"saycode-dpapi-v2","value":"AA=="}', file)).toThrow('WINDOWS_SECRET_READ_FAILED');
    });
});
