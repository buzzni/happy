import { readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join, win32 } from 'node:path';
import { projectPath } from '@/projectPath';
import { createWindowsUserProtection } from './windowsUserProtection';

export class WindowsPrivateFileError extends Error {
    constructor(code: string) { super(code); this.name = 'WindowsPrivateFileError'; }
}
const format = 'saycode-dpapi-v1';
type Protection = ReturnType<typeof createWindowsUserProtection>;
function purpose(file: string): string {
    if (!/^[a-z]:\\/i.test(file) || file.includes('\0') || file.slice(2).includes(':')) throw new WindowsPrivateFileError('WINDOWS_SECRET_INVALID_PATH');
    return format + ':' + win32.resolve(file).toLowerCase();
}
function protection(): Protection {
    try {
        const root = join(projectPath(), 'native', 'windows-x64');
        const manifest = JSON.parse(readFileSync(join(root, 'user-protection.json'), 'utf8'));
        if (manifest.version !== 1 || typeof manifest.sha256 !== 'string') throw new Error();
        return createWindowsUserProtection({ helperPath: join(root, 'user-protection.exe'), helperSha256: manifest.sha256 });
    } catch { throw new WindowsPrivateFileError('WINDOWS_SECRET_HELPER_UNAVAILABLE'); }
}

/** Reader-first rollout: callers enable required writes only after the paired
 * Desktop/Happy build is verified. Recognised ciphertext never falls back to JSON.
 * Native file readers authenticate ciphertext or require handle-verified legacy custody.
 */
export function createWindowsPrivateFileCodec(
    getProtection: () => Protection = protection,
    required: () => boolean = () => platform() === 'win32',
) {
    return {
        version: 1 as const,
        checkReady(): void {
            const api = getProtection(), probe = Buffer.from('saycode-private-storage-capability-v1');
            const decoded = api.unprotect(api.protect(probe, 'storage-capability-v1'), 'storage-capability-v1');
            try { if (!decoded.equals(probe)) throw new WindowsPrivateFileError('WINDOWS_SECRET_HELPER_UNAVAILABLE'); }
            finally { decoded.fill(0); }
        },
        prepareDirectory: (path: string) => { getProtection().prepareDirectory(path); },
        storageRoots: () => getProtection().storageRoots(),
        readBytes(file: string, bindingPath = file): Buffer {
            let raw: Buffer | undefined;
            try {
                raw = getProtection().readProtectedFile(file, purpose(bindingPath));
                const prefix = 'saycode-binary-v1:';
                if (!raw.subarray(0, prefix.length).equals(Buffer.from(prefix))) return Buffer.from(raw);
                const encoded = raw.subarray(prefix.length).toString('ascii'), bytes = Buffer.from(encoded, 'base64');
                if (bytes.toString('base64') !== encoded) throw new Error();
                return bytes;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
                throw new WindowsPrivateFileError('WINDOWS_SECRET_READ_FAILED');
            } finally { raw?.fill(0); }
        },
        writeBytes(file: string, contents: Buffer, bindingPath = file, createOnly = false): void {
            try { getProtection().writeProtectedFile(file, 'saycode-binary-v1:' + contents.toString('base64'), purpose(bindingPath), createOnly); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
                throw new WindowsPrivateFileError('WINDOWS_SECRET_WRITE_FAILED');
            }
        },
        read(file: string, bindingPath = file): string {
            let raw: Buffer | undefined;
            try {
                raw = getProtection().readProtectedFile(file, purpose(bindingPath));
                return new TextDecoder('utf-8', { fatal: true }).decode(raw);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
                throw new WindowsPrivateFileError('WINDOWS_SECRET_READ_FAILED');
            } finally { raw?.fill(0); }
        },
        write(file: string, contents: string, bindingPath = file, createOnly = false): void {
            try { getProtection().writeProtectedFile(file, contents, purpose(bindingPath), createOnly); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
                throw new WindowsPrivateFileError('WINDOWS_SECRET_WRITE_FAILED');
            }
        },
        encode(contents: string, bindingPath: string, previous?: string): string {
            let alreadyProtected = false;
            try { alreadyProtected = !!previous && JSON.parse(previous)?.storage === format; } catch { /* legacy is handled separately */ }
            if (!required() && !alreadyProtected) return contents;
            let raw: Buffer | undefined;
            try {
                raw = Buffer.from(contents, 'utf8');
                return JSON.stringify({ storage: format, value: getProtection().protect(raw, purpose(bindingPath)).toString('base64') });
            } catch { throw new WindowsPrivateFileError('WINDOWS_SECRET_WRITE_FAILED'); }
            finally { raw?.fill(0); }
        },
        decode(contents: string, bindingPath: string): string {
            let parsed: unknown;
            try { parsed = JSON.parse(contents); } catch { /* A protected home must not accept damaged legacy input. */ }
            if (!parsed || typeof parsed !== 'object' || !('storage' in parsed)) {
                if (required()) throw new WindowsPrivateFileError('WINDOWS_SECRET_LEGACY_UNPROTECTED');
                return contents;
            }
            let raw: Buffer | undefined;
            try {
                const record = parsed as { storage: unknown; value: unknown };
                if (record.storage !== format || typeof record.value !== 'string' || platform() !== 'win32') throw new Error();
                const encrypted = Buffer.from(record.value, 'base64');
                if (encrypted.toString('base64') !== record.value) throw new Error();
                raw = getProtection().unprotect(encrypted, purpose(bindingPath));
                return new TextDecoder('utf-8', { fatal: true }).decode(raw);
            } catch { throw new WindowsPrivateFileError('WINDOWS_SECRET_READ_FAILED'); }
            finally { raw?.fill(0); }
        },
    };
}

export const windowsPrivateFile = createWindowsPrivateFileCodec();
