import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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

            expect(result.providerPath).toEqual(expect.any(String));
            expect(result.sandboxConfig.sessionIsolation).toBe('custom');
            expect(result.sandboxConfig.customWritePaths).toEqual([result.providerPath]);
            expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
                'existing-deny',
                canonicalProjectPath,
                join(canonicalProjectPath, '**', '.env*'),
            ]));
            expect(result.beforeTurn).toEqual(expect.any(Function));
            const turn = await result.beforeTurn?.();
            expect(turn).toMatchObject({
                operationId: expect.any(String),
                checkpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
                providerPath: result.providerPath,
                sandboxConfig: {
                    denyWritePaths: expect.arrayContaining([canonicalProjectPath]),
                },
            });
            await expect(readFile(join(turn!.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
            if (provider === 'claude-remote') {
                expect(turn!.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        allowWrite: expect.arrayContaining([turn!.providerPath]),
                        denyWrite: expect.arrayContaining([canonicalProjectPath]),
                    },
                });
                expect(turn!.claudeSandbox?.filesystem?.denyWrite).toEqual(expect.arrayContaining([
                    join(turn!.providerPath, '**', '.env*'),
                ]));
                expect(result.claudeSandbox).toMatchObject({
                    enabled: true,
                    failIfUnavailable: true,
                    allowUnsandboxedCommands: false,
                    filesystem: {
                        denyWrite: expect.arrayContaining([
                            join(result.providerPath!, 'existing-deny'),
                            join(canonicalProjectPath, '**', '.env*'),
                            canonicalProjectPath,
                        ]),
                    },
                });
            } else {
                expect(result.claudeSandbox).toBeUndefined();
            }
        },
    );

    it('applies an isolated diff only after the provider writer tree is quiescent', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
        });
        expect(result.protectedBashCwd?.()).toBeNull();
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        expect(result.protectedBashCwd?.()).toBe(turn.providerPath);
        await writeFile(join(turn.providerPath, 'source.txt'), 'agent change');

        let releaseQuiescence!: () => void;
        const quiescence = new Promise<void>((resolve) => {
            releaseQuiescence = resolve;
        });
        const completion = result.completeTurn(() => quiescence);
        await new Promise((resolve) => setTimeout(resolve, 0));

        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        releaseQuiescence();
        await expect(completion).resolves.toMatchObject({
            status: 'completed',
            entries: [{ path: 'source.txt', action: 'write', outcome: 'written' }],
        });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent change');
        expect(result.protectedBashCwd?.()).toBeNull();
    });

    it('starts the next turn from a fresh checkpoint in the stable provider workspace slot', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'first turn');
        await result.completeTurn(async () => {});
        const second = await result.beforeTurn();

        expect(second.providerPath).toBe(first.providerPath);
        expect(second.operationId).not.toBe(first.operationId);
        expect(second.checkpointId).not.toBe(first.checkpointId);
        await expect(readFile(join(second.providerPath, 'source.txt'), 'utf8')).resolves.toBe('first turn');
        await result.completeTurn(async () => {});
    });
});
