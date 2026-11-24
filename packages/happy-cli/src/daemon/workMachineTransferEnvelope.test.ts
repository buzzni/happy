import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { create as createTar, extract as extractTar } from 'tar';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { proveWorkMachineArchiveRecipient, restoreWorkMachineArchive, sealWorkMachineArchive } from './workMachineTransferEnvelope';

const source = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
const target = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
const other = { signing: nacl.sign.keyPair(), recipient: nacl.box.keyPair() };
const fingerprint = (keys: typeof source) => createHash('sha256')
    .update(Buffer.from('302a300506032b6570032100', 'hex')).update(keys.signing.publicKey).digest('base64url');
const now = 1_800_000_000_000;
const approvalDetails = {
    taskId: 'transfer-job', machineId: 'same-logical-machine', accountId: 'test-account', generation: 2,
    sourceDeviceId: fingerprint(source), targetDeviceId: fingerprint(target),
    expiresAt: now + 60_000, maxBytes: 8_192,
};
const approval = proveWorkMachineArchiveRecipient(approvalDetails, target);
const archive = Buffer.from('synthetic workspace and Claude/Codex archive');

describe('work machine archive encryption', () => {
    let directory: string;
    beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'work-machine-envelope-test-')); });
    afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

    const seal = (destination: string, contents = archive) => sealWorkMachineArchive({
        approval, sourceKeys: source, source: Readable.from([contents]), destination, now,
    });

    it('authenticates the approved source and restores privately to the approved target', async () => {
        const path = join(directory, 'bundle.enc');
        const receipt = await seal(path);
        expect((await readFile(path)).includes(archive)).toBe(false);
        const restored = await restoreWorkMachineArchive({
            approval, targetKeys: target, source: path, receipt, stagingRoot: directory, now,
        });
        expect(await readFile(restored.archivePath)).toEqual(archive);
        expect((await stat(restored.archivePath)).mode & 0o777).toBe(0o600);
        expect(restored.bytes).toBe(archive.length);
    });

    it('rejects changed approval, other devices, expired work and changed receipts or ciphertext', async () => {
        const path = join(directory, 'bundle.enc');
        const receipt = await seal(path);
        const input = { approval, targetKeys: target, source: path, receipt, stagingRoot: directory, now };
        for (const changed of [
            { ...input, approval: { ...approval, taskId: 'another-job' } },
            { ...input, approval: { ...approval, generation: 3 } },
            { ...input, targetKeys: other },
            { ...input, now: approval.expiresAt },
            { ...input, receipt: { ...receipt, sourcePublicKey: Buffer.from(other.signing.publicKey).toString('base64url') } },
        ]) {
            await expect(restoreWorkMachineArchive(changed)).rejects.toThrow();
            expect(await readdir(directory)).toEqual(['bundle.enc']);
        }
        const tampered = await readFile(path);
        tampered[tampered.length - 1] ^= 1;
        await writeFile(path, tampered);
        await expect(restoreWorkMachineArchive(input)).rejects.toThrow();
        expect(await readdir(directory)).toEqual(['bundle.enc']);
    });

    it('rejects a recipient-key substitution even with the same target device id', async () => {
        const destination = join(directory, 'substitution.enc');
        await expect(sealWorkMachineArchive({
            sourceKeys: source, source: Readable.from([archive]), destination, now,
            approval: { ...approval, targetRecipientKey: Buffer.from(other.recipient.publicKey).toString('base64url') },
        })).rejects.toThrow();
        expect(await readdir(directory)).toEqual([]);
    });

    it('enforces the approved size and preserves an existing destination', async () => {
        const path = join(directory, 'bundle.enc');
        await expect(seal(path, Buffer.alloc(approval.maxBytes + 1))).rejects.toThrow();
        expect(await readdir(directory)).toEqual([]);
        await writeFile(path, 'existing file');
        await expect(seal(path)).rejects.toThrow();
        expect(await readFile(path, 'utf8')).toBe('existing file');
    });

    it('removes the sealed output when the approval expires during streaming', async () => {
        const time = vi.spyOn(Date, 'now').mockReturnValue(now);
        const stream = Readable.from((async function* () {
            yield archive;
            time.mockReturnValue(approval.expiresAt);
        })());
        try {
            await expect(sealWorkMachineArchive({
                approval, sourceKeys: source, source: stream, destination: join(directory, 'expired.enc'),
            })).rejects.toThrow('expired');
            expect(await readdir(directory)).toEqual([]);
        } finally {
            time.mockRestore();
        }
    });

    it('restores a dirty linked Git worktree and selected provider records at their original paths', async () => {
        const root = join(directory, 'machine-data');
        const repo = join(root, 'workspace');
        const worktree = join(root, 'worktree');
        const git = (cwd: string, ...args: string[]) => execFileSync('git', [
            '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
            '-c', 'user.name=Migration Test', '-c', 'user.email=test@example.invalid',
            ...args,
        ], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        await mkdir(repo, { recursive: true });
        git(repo, 'init', '--template=');
        await writeFile(join(repo, 'tracked.txt'), 'original\n');
        git(repo, 'add', '.');
        git(repo, 'commit', '-m', 'fixture');
        git(repo, 'worktree', 'add', '-b', 'migration-fixture', worktree);
        await writeFile(join(worktree, 'tracked.txt'), 'staged\n');
        git(worktree, 'add', 'tracked.txt');
        await writeFile(join(worktree, 'tracked.txt'), 'unstaged\n');
        await writeFile(join(worktree, 'draft.txt'), 'untracked\n');
        const status = git(worktree, 'status', '--porcelain=v1');
        const head = git(worktree, 'rev-parse', 'HEAD');
        const providerFiles = [
            ['claude/projects/workspace/native-claude.jsonl', JSON.stringify({ type: 'user', sessionId: 'native-claude', cwd: worktree, message: { role: 'user', content: 'test clue' } }) + '\n'],
            ['codex/sessions/2026/11/22/rollout-test.jsonl', JSON.stringify({ type: 'session_meta', payload: { id: 'native-codex', cwd: worktree } }) + '\n'],
        ] as const;
        for (const [relative, contents] of providerFiles) {
            const path = join(root, relative);
            await mkdir(join(path, '..'), { recursive: true });
            await writeFile(path, contents);
        }
        await writeFile(join(root, 'codex', 'auth.json'), '{"testOnly":"excluded"}');
        const archiveApproval = proveWorkMachineArchiveRecipient({ ...approvalDetails, maxBytes: 2 * 1024 * 1024 }, target);
        const encrypted = join(directory, 'snapshot.enc');
        const tar = createTar({ cwd: root, portable: true, strict: true },
            ['workspace', 'worktree', ...providerFiles.map(([path]) => path)]);
        const receipt = await sealWorkMachineArchive({
            approval: archiveApproval, sourceKeys: source, source: Readable.from(tar), destination: encrypted, now,
        });
        const restored = await restoreWorkMachineArchive({
            approval: archiveApproval, targetKeys: target, receipt, source: encrypted, stagingRoot: directory, now,
        });
        const replacement = join(directory, 'replacement');
        await mkdir(replacement, { mode: 0o700 });
        await extractTar({ cwd: replacement, file: restored.archivePath, strict: true });
        await rename(root, join(directory, 'original'));
        await rename(replacement, root);

        expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
        expect(git(worktree, 'status', '--porcelain=v1')).toBe(status);
        expect(status).toContain('MM tracked.txt');
        expect(status).toContain('?? draft.txt');
        for (const [path, contents] of providerFiles) expect(await readFile(join(root, path), 'utf8')).toBe(contents);
        await expect(stat(join(root, 'codex', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});
