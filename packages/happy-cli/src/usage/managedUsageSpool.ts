import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
/** Fixed image path. Ciphertext only; keys and ACKs stay in the daemon's private home. */
export const MANAGED_USAGE_SPOOL_ROOT = '/workspace/.saycode-usage-spool';
/** Called by root runtime boot, before an untrusted provider can create entries. */
export function prepareManagedUsageSpool(root = MANAGED_USAGE_SPOOL_ROOT, owner = 0): void {
    try { mkdirSync(root, { mode: 0o1777 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== owner) throw new Error('unsafe managed usage spool root');
    chmodSync(root, 0o1777);
}

import { constants, closeSync, fstatSync, fsyncSync, openSync, opendirSync, readSync, unlinkSync, type Dir } from 'node:fs';
import { createHash } from 'node:crypto';
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** One bounded read on a pinned, nonblocking regular file. Never read an untrusted path to EOF. */
export function readBoundedUsageFd(fd: number, maximum: number): string {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink < 1 || info.size > maximum) throw new Error('unsafe usage spool file');
    const buffer = Buffer.alloc(maximum + 1);
    const bytes = readSync(fd, buffer, 0, maximum + 1, 0);
    if (bytes > maximum) throw new Error('oversize usage spool file');
    return buffer.subarray(0, bytes).toString('utf8');
}
export function readBoundedUsageFile(path: string, maximum: number): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { return readBoundedUsageFd(fd, maximum); } finally { closeSync(fd); }
}
export function isAcknowledgedCiphertext(ack: string, event: string): boolean {
    try {
        const proof = JSON.parse(readBoundedUsageFile(ack, 256));
        return /^[a-f0-9]{64}$/.test(proof.digest) && proof.digest === digest(readBoundedUsageFile(event, 1024 * 1024));
    } catch { return false; }
}
/** Root supervisor maintenance only. No RPC accepts a path or requests a deletion.
 * Directory fds pin every deletion to its verified inode, even if a provider renames it.
 */
export class ManagedUsageSpoolCleanup {
    private roots?: Dir;
    private privateRootFd?: number;
    private publicRootFd?: number;
    private current?: { name: string; reader: Dir; privateFd: number; publicFd: number };
    private timer?: ReturnType<typeof setInterval>;
    constructor(private readonly scope: { privateRoot: string; daemonUid: number; providerUid: number;
        ciphertextRoot?: string; retentionMs?: number; warn: () => void }) {}
    start(): void { this.timer = setInterval(() => this.step(), 30_000); this.timer.unref(); this.step(); }
    private directory(path: string, uid: number, privateMode: boolean): number {
        const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        const info = fstatSync(fd);
        if (!info.isDirectory() || info.uid !== uid || (info.mode & (privateMode ? 0o077 : 0o022)) !== 0) {
            closeSync(fd); throw new Error('unsafe cleanup directory');
        }
        return fd;
    }
    step(): void {
        if (process.platform !== 'linux') return; // production managed images are Linux
        try {
            const root = this.scope.ciphertextRoot ?? MANAGED_USAGE_SPOOL_ROOT;
            if (this.publicRootFd === undefined) {
                const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                const info = fstatSync(fd);
                if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o7777) !== 0o1777) { closeSync(fd); throw new Error('unsafe ciphertext root'); }
                this.publicRootFd = fd;
            }
            if (!this.roots) {
                this.privateRootFd ??= this.directory(this.scope.privateRoot, this.scope.daemonUid, true);
                this.roots = opendirSync(`/proc/self/fd/${this.privateRootFd}`);
            }
            let budget = 100;
            for (let i = 0; i < 32 && budget > 0; i++) {
                if (!this.current) {
                    const dir = this.roots.readSync();
                    if (!dir) { this.roots.closeSync(); this.roots = undefined; return; }
                    if (!dir.isDirectory() || !/^[a-f0-9]{64}$/.test(dir.name)) continue;
                    let privateFd: number | undefined, publicFd: number | undefined;
                    try {
                        privateFd = this.directory(`/proc/self/fd/${this.privateRootFd}/${dir.name}`, this.scope.daemonUid, true);
                        publicFd = this.directory(`/proc/self/fd/${this.publicRootFd}/${dir.name}`, this.scope.providerUid, false);
                        this.current = { name: dir.name, privateFd, publicFd, reader: opendirSync(`/proc/self/fd/${privateFd}`) };
                    } catch (error) {
                        if (privateFd !== undefined) closeSync(privateFd);
                        if (publicFd !== undefined) closeSync(publicFd);
                        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.scope.warn();
                        continue;
                    }
                }
                const item = this.current;
                while (budget-- > 0) {
                    const entry = item.reader.readSync();
                    if (!entry) { this.closeCurrent(); break; }
                    if (!entry.isFile() || !/^[a-f0-9]{64}\.json\.ack$/.test(entry.name)) continue;
                    const ack = `/proc/self/fd/${item.privateFd}/${entry.name}`;
                    const event = `/proc/self/fd/${item.publicFd}/${entry.name.slice(0, -4)}`;
                    const proofFd = openSync(ack, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
                    try {
                        const proof = fstatSync(proofFd);
                        if (!proof.isFile() || proof.uid !== this.scope.daemonUid || proof.nlink !== 1 || (proof.mode & 0o077)
                            || proof.size > 256 || Date.now() - proof.mtimeMs < (this.scope.retentionMs ?? 30_000)) continue;
                        let ciphertextFd: number;
                        try { ciphertextFd = openSync(event, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
                        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { unlinkSync(ack); continue; } throw error; }
                        try {
                            const info = fstatSync(ciphertextFd), record = JSON.parse(readBoundedUsageFd(proofFd, 256));
                            if (!info.isFile() || info.uid !== this.scope.providerUid || info.nlink !== 1 || info.size > 1024 * 1024
                                || !/^[a-f0-9]{64}$/.test(record.digest) || digest(readBoundedUsageFd(ciphertextFd, 1024 * 1024)) !== record.digest) continue;
                            const live = lstatSync(event);
                            if (!live.isFile() || live.ino !== info.ino || live.dev !== info.dev) continue;
                            unlinkSync(event); fsyncSync(item.publicFd);
                            unlinkSync(ack); fsyncSync(item.privateFd);
                        } finally { closeSync(ciphertextFd); }
                    } finally { closeSync(proofFd); }
                }
            }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.scope.warn(); }
    }
    private closeCurrent(): void {
        if (!this.current) return;
        this.current.reader.closeSync(); closeSync(this.current.privateFd); closeSync(this.current.publicFd); this.current = undefined;
    }
    stop(): void {
        clearInterval(this.timer); this.closeCurrent(); this.roots?.closeSync(); this.roots = undefined;
        if (this.privateRootFd !== undefined) { closeSync(this.privateRootFd); this.privateRootFd = undefined; }
        if (this.publicRootFd !== undefined) { closeSync(this.publicRootFd); this.publicRootFd = undefined; }
    }
}
