import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { win32 } from 'node:path';

const LIMIT = 8 * 1024 * 1024;
export type WindowsUserProtectionOptions = { helperPath: string; helperSha256: string };
const currentUserBlob = (value: Buffer) => value.length >= 44 && value.readUInt32LE(0) === 1 && !(value.readUInt32LE(40) & 4);

/**
 * Caller selects an integrity-verified bundled helper, never a PATH lookup or
 * renderer-supplied executable. Its installation ancestors remain caller-owned.
 * This primitive does not grant permission to adopt or overwrite a legacy file.
 */
export function createWindowsUserProtection(options: WindowsUserProtectionOptions) {
    function invoke(operation: 'protect' | 'unprotect' | 'read-private-legacy' | 'read-protected' | 'publish-protected' | 'write-protected' | 'prepare-directory' | 'storage-roots', value: Buffer, purpose: string): Buffer {
        if (!Buffer.isBuffer(value) || value.length === 0 || value.length > LIMIT ||
            typeof purpose !== 'string' || purpose.length === 0 || purpose.length > 4096 || purpose.includes('\0')) {
            throw new Error('WINDOWS_SECRET_INVALID_INPUT');
        }
        if (operation === 'unprotect' && !currentUserBlob(value)) throw new Error('WINDOWS_SECRET_INVALID_CIPHERTEXT');
        try {
            const file = options.helperPath;
            if (platform() !== 'win32' || !/^[a-z]:\\/i.test(file) || win32.normalize(file) !== file ||
                file.slice(2).includes(':') || !/\.exe$/i.test(file) || !/^[a-f0-9]{64}$/.test(options.helperSha256)) throw new Error();
            const stat = lstatSync(file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error();
            if (createHash('sha256').update(readFileSync(file)).digest('hex') !== options.helperSha256) throw new Error();
        } catch { throw new Error('WINDOWS_SECRET_HELPER_INVALID'); }
        try {
            const result = spawnSync(options.helperPath, [], {
                input: Buffer.from(JSON.stringify({ version: 1, operation, purpose, value: value.toString('base64') })),
                windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], timeout: 15000, maxBuffer: LIMIT * 2,
            });
            if (result.error || result.signal || !result.stdout) throw new Error();
            const reply = JSON.parse(result.stdout.toString());
            if (reply.version === 1 && reply.ok === false && ['ENOENT', 'EEXIST'].includes(reply.error) && operation !== 'protect' && operation !== 'unprotect') {
                throw Object.assign(new Error(reply.error), { code: reply.error });
            }
            if (result.status !== 0 || reply.version !== 1 || reply.ok !== true || typeof reply.value !== 'string') throw new Error();
            const output = Buffer.from(reply.value, 'base64');
            if (output.length === 0 || output.length > LIMIT || output.toString('base64') !== reply.value ||
                (operation === 'protect' && !currentUserBlob(output))) { output.fill(0); throw new Error(); }
            return output;
        } catch (error) {
            if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
            // spawn errors include command/stdout/stderr in their message. Never expose them.
            throw new Error('WINDOWS_SECRET_PROTECTION_FAILED');
        }
    }
    return {
        protect: (value: Buffer, purpose: string) => invoke('protect', value, purpose),
        unprotect: (value: Buffer, purpose: string) => invoke('unprotect', value, purpose),
        readPrivateLegacy: (path: string) => invoke('read-private-legacy', Buffer.from(path, 'utf8'), 'legacy-custody-v1'),
        readProtectedFile: (path: string, purpose: string) => invoke('read-protected', Buffer.from(path, 'utf8'), purpose),
        publishProtectedFile: (path: string, contents: string, purpose: string, createOnly = false) => {
            invoke('publish-protected', Buffer.from(JSON.stringify({ path, contents, createOnly }), 'utf8'), purpose);
        },
        writeProtectedFile: (path: string, contents: string, purpose: string, createOnly = false) => {
            invoke('write-protected', Buffer.from(JSON.stringify({ path, contents, createOnly }), 'utf8'), purpose);
        },
        prepareDirectory: (path: string) => { invoke('prepare-directory', Buffer.from(path, 'utf8'), 'directory-v1'); },
        storageRoots: (): string[] => {
            const value: unknown = JSON.parse(invoke('storage-roots', Buffer.from('1'), 'locations-v1').toString('utf8'));
            if (!Array.isArray(value) || value.length !== 2 || value.some(root => typeof root !== 'string' || !/^[a-z]:\\/i.test(root))) throw new Error('WINDOWS_SECRET_INVALID_PATH');
            return value;
        },
    };
}
