import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutonomousQualityGatePhaseResult } from './autonomousQualityGateRunner';
import {
    captureAutonomousWorktreeFingerprint,
    runWithAutonomousFingerprintGuard,
} from './autonomousQualityGateFingerprint';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const passed: AutonomousQualityGatePhaseResult = {
    name: 'test',
    status: 'passed',
    exitCode: 0,
    timedOut: false,
    durationMs: 10,
    stdoutTail: 'ok',
    stderrTail: '',
    outputTruncated: false,
};

describe('runWithAutonomousFingerprintGuard', () => {
    it('accepts a gate result only while the worktree fingerprint remains current', async () => {
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'a', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'a', entryCount: 1, excludedCount: 0 });

        await expect(runWithAutonomousFingerprintGuard({ capture, run: async () => passed }))
            .resolves.toEqual({
                status: 'accepted',
                fingerprint: { digest: 'a', entryCount: 1, excludedCount: 0 },
                result: passed,
            });
    });

    it('discards a passing result when a concurrent edit changes the fingerprint', async () => {
        const capture = vi.fn()
            .mockResolvedValueOnce({ digest: 'before', entryCount: 1, excludedCount: 0 })
            .mockResolvedValueOnce({ digest: 'after', entryCount: 1, excludedCount: 0 });

        const outcome = await runWithAutonomousFingerprintGuard({ capture, run: async () => passed });

        expect(outcome).toEqual({
            status: 'stale',
            before: { digest: 'before', entryCount: 1, excludedCount: 0 },
            after: { digest: 'after', entryCount: 1, excludedCount: 0 },
        });
        expect(outcome).not.toHaveProperty('result');
    });

    it('changes a clean worktree fingerprint when HEAD advances', async () => {
        const directory = await mkdtemp(join(process.cwd(), '.tmp-autonomous-fingerprint-'));
        temporaryDirectories.push(directory);
        const git = (...args: string[]) => execFileAsync('git', args, { cwd: directory });
        await git('init');
        await writeFile(join(directory, 'value.txt'), 'first\n');
        await git('add', 'value.txt');
        await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'first');
        const first = await captureAutonomousWorktreeFingerprint(directory);

        await writeFile(join(directory, 'value.txt'), 'second\n');
        await git('add', 'value.txt');
        await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'second');
        const second = await captureAutonomousWorktreeFingerprint(directory);

        expect(first.entryCount).toBe(0);
        expect(second.entryCount).toBe(0);
        expect(second.digest).not.toBe(first.digest);
    });

    it('detects metadata changes beyond the bounded content-entry limit', async () => {
        const directory = await mkdtemp(join(process.cwd(), '.tmp-autonomous-fingerprint-'));
        temporaryDirectories.push(directory);
        const git = (...args: string[]) => execFileAsync('git', args, { cwd: directory });
        await git('init');
        const generated = join(directory, 'generated');
        await mkdir(generated);
        await Promise.all(Array.from({ length: 2_049 }, (_, index) => (
            writeFile(join(generated, `${String(index).padStart(4, '0')}.txt`), 'x')
        )));
        const before = await captureAutonomousWorktreeFingerprint(directory);

        await writeFile(join(generated, '2048.txt'), 'changed-size');
        const after = await captureAutonomousWorktreeFingerprint(directory);

        expect(before.excludedCount).toBe(1);
        expect(after.excludedCount).toBe(1);
        expect(after.digest).not.toBe(before.digest);
    });

    it('detects a same-length symlink target change without following the link', async () => {
        const directory = await mkdtemp(join(process.cwd(), '.tmp-autonomous-fingerprint-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init'], { cwd: directory });
        const link = join(directory, 'current-target');
        await symlink('target-a', link);
        const before = await captureAutonomousWorktreeFingerprint(directory);

        await rm(link);
        await symlink('target-b', link);
        const after = await captureAutonomousWorktreeFingerprint(directory);

        expect(after.digest).not.toBe(before.digest);
    });

    it('detects an executable-bit repair without reading any additional content', async () => {
        const directory = await mkdtemp(join(process.cwd(), '.tmp-autonomous-fingerprint-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init'], { cwd: directory });
        const script = join(directory, 'repair.sh');
        await writeFile(script, '#!/bin/sh\necho repaired\n', { mode: 0o600 });
        const before = await captureAutonomousWorktreeFingerprint(directory);

        await chmod(script, 0o700);
        const after = await captureAutonomousWorktreeFingerprint(directory);

        expect(after.digest).not.toBe(before.digest);
    });

    it('does not use excluded secret metadata as retry evidence', async () => {
        const directory = await mkdtemp(join(process.cwd(), '.tmp-autonomous-fingerprint-'));
        temporaryDirectories.push(directory);
        await execFileAsync('git', ['init'], { cwd: directory });
        await writeFile(join(directory, '.env'), 'TOKEN=one');
        const before = await captureAutonomousWorktreeFingerprint(directory);

        await writeFile(join(directory, '.env'), 'TOKEN=a-different-secret');
        const after = await captureAutonomousWorktreeFingerprint(directory);

        expect(before.entryCount).toBe(0);
        expect(after.entryCount).toBe(0);
        expect(after.digest).toBe(before.digest);
    });
});
