import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import {
    planAutonomousFingerprintInputs,
    type AutonomousFingerprintCandidate,
} from './autonomousQualityGateSafety';
import type { AutonomousQualityGatePhaseResult } from './autonomousQualityGateRunner';

const MAX_GIT_STATUS_BYTES = 2 * 1_024 * 1_024;

export interface AutonomousWorktreeFingerprint {
    digest: string;
    entryCount: number;
    excludedCount: number;
}

export type AutonomousFingerprintGuardResult =
    | { status: 'accepted'; fingerprint: AutonomousWorktreeFingerprint; result: AutonomousQualityGatePhaseResult }
    | { status: 'stale'; before: AutonomousWorktreeFingerprint; after: AutonomousWorktreeFingerprint };

export async function runWithAutonomousFingerprintGuard(options: {
    capture: () => Promise<AutonomousWorktreeFingerprint>;
    run: () => Promise<AutonomousQualityGatePhaseResult>;
}): Promise<AutonomousFingerprintGuardResult> {
    const before = await options.capture();
    const result = await options.run();
    const after = await options.capture();
    if (before.digest !== after.digest) return { status: 'stale', before, after };
    return { status: 'accepted', fingerprint: after, result };
}

export async function captureAutonomousWorktreeFingerprint(
    cwd: string,
): Promise<AutonomousWorktreeFingerprint> {
    const changes = await readGitChanges(cwd);
    const candidates: AutonomousFingerprintCandidate[] = [];
    const statusByPath = new Map<string, string>();
    for (const change of changes) {
        statusByPath.set(change.path, change.status);
        try {
            const info = await lstat(join(cwd, change.path));
            candidates.push({ path: change.path, size: info.isFile() ? info.size : 0, binary: !info.isFile() });
        } catch {
            candidates.push({ path: change.path, size: 0, binary: true });
        }
    }

    const plan = planAutonomousFingerprintInputs(candidates);
    const hash = createHash('sha256').update('autonomous-quality-gate-fingerprint-v1\0');
    for (const entry of plan.entries) {
        hash.update(`${statusByPath.get(entry.path) ?? '??'}\0${entry.path}\0${entry.mode}\0`);
        if (entry.mode === 'content') {
            const content = await readBoundedFile(join(cwd, entry.path), entry.maxBytes);
            if (content && !content.includes(0)) hash.update(content);
            else hash.update(`metadata-only:${entry.maxBytes}`);
        }
        hash.update('\0');
    }
    return {
        digest: hash.digest('hex'),
        entryCount: plan.entries.length,
        excludedCount: plan.excludedCount,
    };
}

async function readGitChanges(cwd: string): Promise<Array<{ status: string; path: string }>> {
    const stdout = await new Promise<string>((resolve, reject) => {
        execFile('git', [
            '--no-optional-locks',
            'status',
            '--porcelain=v1',
            '-z',
            '--untracked-files=all',
            '--no-renames',
        ], { cwd, encoding: 'utf8', maxBuffer: MAX_GIT_STATUS_BYTES }, (error, output) => {
            if (error) reject(error);
            else resolve(output);
        });
    });
    return stdout.split('\0').flatMap((record) => {
        if (record.length < 4 || record[2] !== ' ') return [];
        return [{ status: record.slice(0, 2), path: record.slice(3) }];
    });
}

async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer | undefined> {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead);
    } catch {
        return undefined;
    } finally {
        await handle?.close();
    }
}
