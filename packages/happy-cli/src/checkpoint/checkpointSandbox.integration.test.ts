import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { initializeSandbox, wrapCommand } from '@/sandbox/manager';
import { CheckpointExclusionGuard } from './checkpointExclusionPolicy';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const execAsync = promisify(exec);

describe.skipIf(process.platform !== 'darwin')('checkpoint macOS sandbox enforcement', () => {
    let projectPath: string;
    let checkpointRoot: string | null;
    let cleanupSandbox: (() => Promise<void>) | null;

    beforeEach(async () => {
        projectPath = await mkdtemp(join(tmpdir(), 'happy-checkpoint-sandbox-'));
        checkpointRoot = null;
        cleanupSandbox = null;
    });

    afterEach(async () => {
        await cleanupSandbox?.();
        await rm(projectPath, { recursive: true, force: true });
        if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
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

    it('allows shell writes only in the turn workspace and applies them after quiescence', async () => {
        checkpointRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-store-'));
        await writeFile(join(projectPath, 'source.txt'), 'before');
        await writeFile(join(projectPath, '.gitignore'), 'dependencies/\n');
        await mkdir(join(projectPath, 'dependencies'));
        await writeFile(join(projectPath, 'dependencies', 'package.txt'), 'cached dependency');
        const composition = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({
                checkpointProtection: {
                    secretPatterns: ['.env*'],
                    maxFileBytes: 1024,
                    maxFiles: 100,
                    maxTotalBytes: 4096,
                    readOnlyPassthroughPaths: ['dependencies'],
                },
                extraWritePaths: [],
                denyReadPaths: [],
                networkMode: 'blocked',
                allowLocalBinding: false,
            }),
            env: {
                [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                    schemaVersion: 1,
                    projectId: 'project-1',
                    worktreeId: null,
                    checkpointRoot,
                }),
            },
        });
        if (!composition.beforeTurn || !composition.completeTurn || !composition.sandboxConfig) {
            throw new Error('expected protected composition');
        }
        const turn = await composition.beforeTurn();
        await expect(readFile(join(turn.providerPath, 'dependencies', 'package.txt'), 'utf8'))
            .resolves.toBe('cached dependency');
        cleanupSandbox = await initializeSandbox(composition.sandboxConfig, turn.providerPath);

        await execAsync(await wrapCommand(
            `printf agent > ${shellQuote(join(turn.providerPath, 'source.txt'))}`,
        ));
        await expect(execAsync(await wrapCommand(
            `printf secret > ${shellQuote(join(turn.providerPath, '.env.future'))}`,
        ))).rejects.toBeDefined();
        await expect(execAsync(await wrapCommand(
            `printf changed > ${shellQuote(join(turn.providerPath, 'dependencies', 'package.txt'))}`,
        ))).rejects.toBeDefined();
        await expect(execAsync(await wrapCommand(
            `printf bypass > ${shellQuote(join(projectPath, 'source.txt'))}`,
        ))).rejects.toBeDefined();
        await cleanupSandbox();
        cleanupSandbox = null;

        await expect(composition.completeTurn(async () => {})).resolves.toMatchObject({
            status: 'completed',
            entries: [{ path: 'source.txt', action: 'write', outcome: 'written' }],
        });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent');
        await expect(stat(join(projectPath, '.env.future'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
});

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
