import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
    isSafeAutonomousFingerprintPath,
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
    const [changes, head] = await Promise.all([readGitChanges(cwd), readGitHead(cwd)]);
    const candidates: AutonomousFingerprintCandidate[] = [];
    const candidateByPath = new Map<string, AutonomousFingerprintCandidate>();
    const statusByPath = new Map<string, string>();
    for (const change of changes) {
        statusByPath.set(change.path, change.status);
        try {
            const path = join(cwd, change.path);
            const info = await lstat(path);
            const symlinkTarget = info.isSymbolicLink() && isSafeAutonomousFingerprintPath(change.path)
                ? await readlink(path)
                : undefined;
            const candidate = {
                path: change.path,
                size: info.size,
                binary: !info.isFile(),
                fileMode: info.mode & 0o777,
                ...(symlinkTarget !== undefined ? { symlinkTarget } : {}),
            };
            candidates.push(candidate);
            candidateByPath.set(change.path, candidate);
        } catch {
            const candidate = { path: change.path, size: 0, binary: true };
            candidates.push(candidate);
            candidateByPath.set(change.path, candidate);
        }
    }

    const plan = planAutonomousFingerprintInputs(candidates);
    const hash = createHash('sha256')
        .update('autonomous-quality-gate-fingerprint-v2\0')
        .update(`head:${head}\0`);
    for (const change of [...changes].sort((a, b) => a.path.localeCompare(b.path))) {
        if (!isSafeAutonomousFingerprintPath(change.path)) continue;
        const candidate = candidateByPath.get(change.path);
        hash.update(
            `changed:${change.status}\0${change.path}\0${candidate?.size ?? 0}\0${candidate?.binary ? 'binary' : 'file'}\0${candidate?.fileMode ?? 0}\0${candidate?.symlinkTarget ?? ''}\0`,
        );
    }
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

async function readGitHead(cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['rev-parse', '--verify', 'HEAD'], {
            cwd,
            encoding: 'utf8',
            maxBuffer: 256,
        }, (error, output, stderr) => {
            if (!error) resolve(output.trim());
            else if (/needed a single revision|unknown revision|ambiguous argument 'HEAD'/i.test(stderr)) resolve('unborn');
            else reject(error);
        });
    });
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
