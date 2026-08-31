import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { initializeSandbox, wrapCommand } from '@/sandbox/manager';
import { CheckpointExclusionGuard } from './checkpointExclusionPolicy';

const execAsync = promisify(exec);

describe.skipIf(process.platform !== 'darwin')('checkpoint macOS sandbox enforcement', () => {
    let projectPath: string;
    let cleanupSandbox: (() => Promise<void>) | null;

    beforeEach(async () => {
        projectPath = await mkdtemp(join(tmpdir(), 'happy-checkpoint-sandbox-'));
        cleanupSandbox = null;
    });

    afterEach(async () => {
        await cleanupSandbox?.();
        await rm(projectPath, { recursive: true, force: true });
    });

    it('denies an existing excluded file and a future secret glob before either write', async () => {
        const largePath = join(projectPath, 'large.bin');
        const allowedPath = join(projectPath, 'allowed.txt');
        const secretDirectory = join(projectPath, 'nested');
        const futureSecretPath = join(secretDirectory, '.env.future');
        await mkdir(secretDirectory);
        await writeFile(largePath, 'unchanged');
        const guard = await CheckpointExclusionGuard.create({
            projectPath,
            secretPatterns: ['.env*'],
            maxFileBytes: 8,
            maxFiles: 100,
            maxTotalBytes: 4096,
        });
        const sandboxConfig = SandboxConfigSchema.parse({
            workspaceRoot: projectPath,
            extraWritePaths: [],
            denyReadPaths: [],
            denyWritePaths: guard.manifest.denyWritePaths,
            networkMode: 'blocked',
            allowLocalBinding: false,
        });
        cleanupSandbox = await initializeSandbox(sandboxConfig, projectPath);

        await execAsync(await wrapCommand(`printf allowed > ${shellQuote(allowedPath)}`));
        await expect(execAsync(
            await wrapCommand(`printf changed > ${shellQuote(largePath)}`),
        )).rejects.toBeDefined();
        await expect(execAsync(
            await wrapCommand(`printf secret > ${shellQuote(futureSecretPath)}`),
        )).rejects.toBeDefined();

        expect(await readFile(allowedPath, 'utf8')).toBe('allowed');
        expect(await readFile(largePath, 'utf8')).toBe('unchanged');
        await expect(stat(futureSecretPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
