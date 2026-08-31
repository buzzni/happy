import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

describe('createCheckpointSessionComposition', () => {
    let fixtureRoot: string;
    let projectPath: string;
    let checkpointRoot: string;

    beforeEach(async () => {
        fixtureRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-composition-'));
        projectPath = join(fixtureRoot, 'project');
        checkpointRoot = join(fixtureRoot, 'checkpoints');
        await mkdir(projectPath);
        await writeFile(join(projectPath, 'source.txt'), 'before');
    });

    afterEach(async () => {
        await rm(fixtureRoot, { recursive: true, force: true });
    });

    const protection = {
        secretPatterns: ['.env*'],
        maxFileBytes: 1024,
        maxFiles: 100,
        maxTotalBytes: 4096,
    };

    function contextEnv() {
        return {
            [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                schemaVersion: 1,
                projectId: 'project-1',
                worktreeId: null,
                checkpointRoot,
            }),
        };
    }

    it('does not create a gate when checkpoint protection was not explicitly configured', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({});
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        });

        expect(result).toEqual({ sandboxConfig });
    });

    it('fails closed without a daemon-owned binding or on an unsupported platform', async () => {
        const sandboxConfig = SandboxConfigSchema.parse({ checkpointProtection: protection });
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: {},
        })).rejects.toThrow('authoritative checkpoint spawn context');
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'linux',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: contextEnv(),
        })).rejects.toThrow('unsupported-platform');
    });

    it.each(['claude-remote', 'codex'] as const)(
        'binds %s sandbox and turn gate to the same protected runtime',
        async (provider) => {
            const result = await createCheckpointSessionComposition({
                provider,
                platform: 'darwin',
                projectPath,
                sessionId: 'session-1',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: protection,
                    denyWritePaths: ['existing-deny'],
                }),
                env: contextEnv(),
            });
            const canonicalProjectPath = await realpath(projectPath);
            if (!result.sandboxConfig) throw new Error('expected protected sandbox config');

            expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
                'existing-deny',
                join(canonicalProjectPath, '**', '.env*'),
            ]));
            expect(result.beforeTurn).toEqual(expect.any(Function));
            await expect(result.beforeTurn?.()).resolves.toBeUndefined();
            if (provider === 'claude-remote') {
                expect(result.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        denyWrite: expect.arrayContaining([
                            join(projectPath, 'existing-deny'),
                            join(canonicalProjectPath, '**', '.env*'),
                        ]),
                    },
                });
            } else {
                expect(result.claudeSandbox).toBeUndefined();
            }
        },
    );
});
