import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

vi.mock('@/sandbox/dependencyPreflight', () => ({
    cachedLinuxSandboxDependencyStatus: vi.fn(() => ({ ok: true })),
}));

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
    const checkpointEvents = {
        snapshot: async () => ({
            id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
        }),
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
            platform: 'win32',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig,
            env: contextEnv(),
        })).rejects.toThrow('unsupported-platform');
    });

    it('fails closed when a protected runtime has no durable event publisher', async () => {
        await expect(createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
        })).rejects.toThrow('durable event publisher');
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
                checkpointEvents,
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
            const canonicalCheckpointRoot = await realpath(checkpointRoot);
            expect(turn).toMatchObject({
                operationId: expect.any(String),
                checkpointId: expect.stringMatching(/^[a-f0-9]{40,64}$/),
                providerPath: result.providerPath,
                sandboxConfig: {
                    denyWritePaths: expect.arrayContaining([canonicalProjectPath]),
                },
            });
            expect(turn!.providerPath.startsWith(`${canonicalCheckpointRoot}${sep}`)).toBe(true);
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

    it('waits for a durable snapshot event acknowledgement before opening the provider turn', async () => {
        const snapshot = vi.fn()
            .mockRejectedValueOnce(new Error('event server unavailable'))
            .mockResolvedValueOnce({
                id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: true,
            });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents: { snapshot },
        });

        await expect(result.beforeTurn?.()).rejects.toThrow('event server unavailable');
        expect(result.protectedBashCwd?.()).toBeNull();
        const retry = await result.beforeTurn?.();

        expect(retry).toBeDefined();
        expect(snapshot).toHaveBeenCalledTimes(2);
        expect(snapshot.mock.calls[1]?.[0]).toEqual(snapshot.mock.calls[0]?.[0]);
        expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
            operationId: retry?.operationId,
            checkpointId: retry?.checkpointId,
        });
    });

    it('applies an isolated diff only after the provider writer tree is quiescent', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
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

    it('rotates the sandbox to a never-reused provider workspace after each completed turn', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'claude-remote',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn) throw new Error('expected protected turn lifecycle');

        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'first turn');
        await result.completeTurn(async () => {});
        const second = await result.beforeTurn();

        expect(second.providerPath).not.toBe(first.providerPath);
        expect(result.providerPath).toBe(second.providerPath);
        expect(result.sandboxConfig?.customWritePaths).toEqual([second.providerPath]);
        expect(result.claudeSandbox?.filesystem?.allowWrite).toContain(second.providerPath);
        expect(result.claudeSandbox?.filesystem?.allowWrite).not.toContain(first.providerPath);
        expect(second.operationId).not.toBe(first.operationId);
        expect(second.checkpointId).not.toBe(first.checkpointId);
        await expect(readFile(join(second.providerPath, 'source.txt'), 'utf8')).resolves.toBe('first turn');
        await result.completeTurn(async () => {});
    });

    it('reserves the provider workspace directory before the first turn and after each rotation', async () => {
        // specs/linux-checkpoint-enforcement-backend R4 — Codex wraps its sandbox in connect(), before
        // beforeTurn() materializes the workspace. Linux bubblewrap skips allowWrite paths that do not
        // exist yet, so the reserved path must already be a directory when the sandbox is built.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.providerPath) throw new Error('expected protected turn lifecycle');

        await expect(stat(result.providerPath)).resolves.toMatchObject({ mode: expect.any(Number) });
        expect((await stat(result.providerPath)).isDirectory()).toBe(true);
        const first = await result.beforeTurn();
        expect(first.providerPath).toBe(result.providerPath);
        await expect(readFile(join(first.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        await result.completeTurn(async () => {});

        expect(result.providerPath).not.toBe(first.providerPath);
        expect((await stat(result.providerPath)).isDirectory()).toBe(true);
        await expect(stat(first.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('omits glob and passthrough deny entries from the Linux sandbox only', async () => {
        // specs/linux-checkpoint-enforcement-backend R3 (2026-09-05 개정) / R8 — bubblewrap cannot
        // enforce globs (and leaves ws/** mount points) and refuses to start when a deny entry is a
        // symlink inside the writable workspace; the passthrough target is already read-only via /.
        await writeFile(join(projectPath, '.gitignore'), 'dependencies/\n');
        await mkdir(join(projectPath, 'dependencies'));
        await writeFile(join(projectPath, 'dependencies', 'package.txt'), 'cached');
        await writeFile(join(projectPath, 'large.bin'), 'x'.repeat(2048));
        const canonicalProjectPath = await realpath(projectPath);
        const configFor = async (platform: NodeJS.Platform) => {
            const result = await createCheckpointSessionComposition({
                provider: 'codex',
                platform,
                projectPath,
                sessionId: `session-${platform}`,
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: { ...protection, readOnlyPassthroughPaths: ['dependencies'] },
                    denyWritePaths: ['user-glob/*.pem'],
                }),
                env: contextEnv(),
                checkpointEvents,
            });
            if (!result.sandboxConfig || !result.providerPath) throw new Error('expected protected sandbox config');
            return { deny: result.sandboxConfig.denyWritePaths, ws: result.providerPath };
        };

        const linux = await configFor('linux');
        expect(linux.deny).toEqual(expect.arrayContaining([
            'user-glob/*.pem',
            canonicalProjectPath,
            join(linux.ws, 'large.bin'),
        ]));
        expect(linux.deny).not.toContain(join(canonicalProjectPath, '**', '.env*'));
        expect(linux.deny).not.toContain(join(linux.ws, '**', '.env*'));
        expect(linux.deny).not.toContain(join(linux.ws, 'dependencies'));

        const darwin = await configFor('darwin');
        expect(darwin.deny).toEqual(expect.arrayContaining([
            'user-glob/*.pem',
            canonicalProjectPath,
            join(canonicalProjectPath, '**', '.env*'),
            join(darwin.ws, '**', '.env*'),
            join(darwin.ws, 'dependencies'),
            join(darwin.ws, 'large.bin'),
        ]));
    });

    it('keeps literal deny entries on Linux even when the project path contains glob characters', async () => {
        const oddProjectPath = join(fixtureRoot, 'app[1]?');
        await mkdir(oddProjectPath);
        await writeFile(join(oddProjectPath, 'source.txt'), 'before');
        await writeFile(join(oddProjectPath, 'large.bin'), 'x'.repeat(2048));
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'linux',
            projectPath: oddProjectPath,
            sessionId: 'session-odd',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.sandboxConfig || !result.providerPath) throw new Error('expected protected sandbox config');
        const canonicalOddPath = await realpath(oddProjectPath);
        expect(result.sandboxConfig.denyWritePaths).toEqual(expect.arrayContaining([
            canonicalOddPath,
            join(canonicalOddPath, 'large.bin'),
            join(result.providerPath, 'large.bin'),
        ]));
        expect(result.sandboxConfig.denyWritePaths).not.toContain(join(canonicalOddPath, '**', '.env*'));
    });

    it('dispose removes an unused workspace reservation but never an active turn', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-dispose',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.providerPath || !result.dispose) {
            throw new Error('expected protected turn lifecycle');
        }
        const reserved = result.providerPath;
        const turn = await result.beforeTurn();
        await result.dispose();
        await expect(readFile(join(turn.providerPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        await result.completeTurn(async () => {});

        const nextReserved = result.providerPath;
        expect(nextReserved).not.toBe(reserved);
        await result.dispose();
        await expect(stat(nextReserved)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(result.dispose()).resolves.toBeUndefined();
    });

    it('abortTurn discards a turn that was opened but never dispatched', async () => {
        // specs/linux-checkpoint-enforcement-backend R4 — the gate now opens the turn before the
        // provider process starts, so a turn that never gets dispatched (reconnect failure, refusal,
        // session exit) must not leave the workspace materialized nor block the next gate.
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-abort',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        if (!result.beforeTurn || !result.completeTurn || !result.abortTurn) {
            throw new Error('expected protected turn lifecycle');
        }
        const first = await result.beforeTurn();
        await writeFile(join(first.providerPath, 'source.txt'), 'never dispatched');

        await result.abortTurn();

        // The abandoned workspace is gone, the original is untouched, and the writable path rotates.
        await expect(stat(first.providerPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        expect(result.providerPath).not.toBe(first.providerPath);
        expect(result.protectedBashCwd?.()).toBeNull();

        // The next gate opens normally instead of throwing 'already active'.
        const second = await result.beforeTurn();
        expect(second.providerPath).toBe(result.providerPath);
        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({ status: 'completed' });
        await expect(result.abortTurn()).resolves.toBeUndefined();
    });

    it('records a daemon-readable pending decision when policy drift blocks dispatch', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        await writeFile(join(projectPath, '.env.production'), 'secret');

        await expect(result.beforeTurn?.()).rejects.toMatchObject({
            name: 'CheckpointPolicyDriftError',
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: expect.any(String),
                source: 'policy-drift',
                excluded: [{ path: '.env.production', reason: 'secret' }],
            },
        });
    });

    it('records an excluded-path conflict discovered by the turn applier', async () => {
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });
        const turn = await result.beforeTurn?.();
        if (!turn || !result.completeTurn) throw new Error('expected protected turn lifecycle');
        await writeFile(join(turn.providerPath, '.env.future'), 'sandbox bypass');

        await expect(result.completeTurn(async () => {})).resolves.toMatchObject({
            entries: [{ path: '.env.future', action: 'conflict', outcome: 'conflict' }],
        });
        await expect(new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        })).resolves.toMatchObject({
            protection: { status: 'protected' },
            pendingDecision: {
                operationId: turn.operationId,
                source: 'turn-apply',
                excluded: [{ path: '.env.future', reason: 'secret' }],
            },
        });
        await expect(result.beforeTurn?.()).rejects.toThrow('excluded path decision is pending');
    });

    it('starts a restarted session without checkpoint protection after explicit disable', async () => {
        const state = new CheckpointProtectionStateStore(checkpointRoot);
        const binding = {
            sessionId: 'session-1',
            projectId: 'project-1',
            worktreeId: null,
            projectPath,
        } as const;
        await state.reportPending({
            ...binding,
            operationId: 'turn-1',
            source: 'policy-drift',
            excluded: [],
        });
        await state.resolveDecision({
            ...binding,
            operationId: 'turn-1',
            decision: 'disable-protection',
        });
        const result = await createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'darwin',
            projectPath,
            sessionId: 'session-1',
            sandboxConfig: SandboxConfigSchema.parse({ checkpointProtection: protection }),
            env: contextEnv(),
            checkpointEvents,
        });

        expect(result.beforeTurn).toBeUndefined();
        expect(result.sandboxConfig?.checkpointProtection).toBeUndefined();
        expect(result.sandboxConfig?.enabled).toBe(true);
    });
});
