import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeRemote } from '@/claude/claudeRemote';
import type { EnhancedMode } from '@/claude/loop';
import { CodexAppServerClient } from '@/codex/codexAppServerClient';
import { SandboxConfigSchema } from '@/persistence';
import { CheckpointRestoreExecutor } from './checkpointRestore';
import { CheckpointRestorePlanner } from './checkpointRestorePlan';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const providerSmokeEnabled = process.env.HAPPY_RUN_CHECKPOINT_PROVIDER_SMOKE === '1';
const providerSmokeRoot = process.env.HAPPY_CHECKPOINT_PROVIDER_SMOKE_ROOT ?? tmpdir();
// specs/linux-checkpoint-enforcement-backend — runs on macOS and Linux (bubblewrap); still opt-in.
describe.skipIf((process.platform !== 'darwin' && process.platform !== 'linux') || !providerSmokeEnabled)(
    'checkpoint protected provider smoke',
    { timeout: 180_000 },
    () => {
        let projectPath: string | null = null;
        let checkpointRoot: string | null = null;
        let client: CodexAppServerClient | null;

        beforeEach(async () => {
            projectPath = null;
            checkpointRoot = null;
            await mkdir(providerSmokeRoot, { recursive: true });
            projectPath = await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-project-'));
            checkpointRoot = await mkdtemp(join(providerSmokeRoot, 'happy-checkpoint-provider-store-'));
            client = null;
            await writeFile(join(projectPath, 'README.md'), '# Provider smoke\n');
        });

        afterEach(async () => {
            await client?.disconnect();
            if (projectPath) await rm(projectPath, { recursive: true, force: true });
            if (checkpointRoot) await rm(checkpointRoot, { recursive: true, force: true });
        });

        it('applies a real Codex file edit only through the protected turn boundary', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const checkpointEvents = captureCheckpointEvents();
            const events: Array<{
                type: string;
                message?: string;
                command?: unknown;
                cwd?: unknown;
                output?: unknown;
            }> = [];
            const composition = await createCheckpointSessionComposition({
                provider: 'codex',
                platform: process.platform,
                projectPath,
                sessionId: 'provider-smoke-codex',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
                checkpointEvents: checkpointEvents.publisher,
            });
            client = new CodexAppServerClient(
                composition.sandboxConfig,
                composition.beforeTurn,
                composition.completeTurn,
            );
            client.setEventHandler((event) => {
                events.push({
                    type: event.type,
                    ...('message' in event && typeof event.message === 'string'
                        ? { message: event.message }
                        : {}),
                    ...('command' in event ? { command: event.command } : {}),
                    ...('cwd' in event ? { cwd: event.cwd } : {}),
                    ...('output' in event ? { output: event.output } : {}),
                });
            });
            // Mirror runCodex: the gate opens (and materializes) the turn workspace before codex is
            // wrapped and spawned. specs/linux-checkpoint-enforcement-backend R4.
            await client.prepareProtectedTurn();
            await client.connect();
            await client.startThread({
                cwd: projectPath,
                approvalPolicy: 'never',
                sandbox: 'danger-full-access',
            });

            const result = await client.sendTurnAndWait(
                "Run this shell command in the current workspace exactly once: printf 'protected codex\\n' > provider-smoke.txt\n"
                    + 'Do not modify any other file. Finish immediately after the command succeeds.',
                { approvalPolicy: 'never', sandbox: 'danger-full-access' },
            );

            expect(result.aborted).toBe(false);
            try {
                expect(await readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                    .toBe('protected codex\n');
            } catch (error) {
                throw new Error(`Codex provider smoke did not apply the file: ${JSON.stringify(events)}`, {
                    cause: error,
                });
            }
            await restoreProviderEdit({
                checkpointRoot,
                projectPath,
                sessionId: 'provider-smoke-codex',
                checkpointId: checkpointEvents.checkpointId(),
            });
        });

        it('applies a real Claude file edit only through the protected turn boundary', async () => {
            if (!projectPath || !checkpointRoot) throw new Error('provider smoke fixture is unavailable');
            const checkpointEvents = captureCheckpointEvents();
            const hookSettingsPath = join(checkpointRoot, 'claude-settings.json');
            await writeFile(hookSettingsPath, '{}\n');
            const composition = await createCheckpointSessionComposition({
                provider: 'claude-remote',
                platform: process.platform,
                projectPath,
                sessionId: 'provider-smoke-claude',
                sandboxConfig: SandboxConfigSchema.parse({
                    checkpointProtection: {
                        secretPatterns: ['.env*'],
                        maxFileBytes: 1024 * 1024,
                        maxFiles: 100,
                        maxTotalBytes: 16 * 1024 * 1024,
                    },
                    extraWritePaths: [],
                    denyReadPaths: [],
                    networkMode: 'allowed',
                    allowLocalBinding: false,
                }),
                env: {
                    [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                        schemaVersion: 1,
                        projectId: 'provider-smoke-project',
                        worktreeId: null,
                        checkpointRoot,
                    }),
                },
                checkpointEvents: checkpointEvents.publisher,
            });
            const mode: EnhancedMode = {
                permissionMode: 'bypassPermissions',
                allowedTools: ['Bash', 'Write', 'Edit'],
            };

            const result = await claudeRemote({
                sessionId: null,
                path: projectPath,
                allowedTools: ['Bash', 'Write', 'Edit'],
                hookSettingsPath,
                exitAfterFirstTurn: true,
                sandbox: composition.claudeSandbox,
                beforeTurn: composition.beforeTurn,
                completeTurn: composition.completeTurn,
                nextMessage: async () => ({
                    message: "Run this shell command in the current workspace exactly once: printf 'protected claude\\n' > provider-smoke.txt\n"
                        + 'Do not modify any other file. Finish immediately after the command succeeds.',
                    mode,
                }),
                onReady: () => {},
                canCallTool: async () => ({ behavior: 'allow' }) as any,
                isAborted: () => false,
                onSessionFound: () => {},
                onMessage: () => {},
            });

            expect(result).toBe('turn-complete');
            await expect(readFile(join(projectPath, 'provider-smoke.txt'), 'utf8'))
                .resolves.toBe('protected claude\n');
            await restoreProviderEdit({
                checkpointRoot,
                projectPath,
                sessionId: 'provider-smoke-claude',
                checkpointId: checkpointEvents.checkpointId(),
            });
        });
    },
);

function captureCheckpointEvents(): {
    publisher: {
        snapshot(event: { checkpointId: string }): Promise<{
            id: string;
            seq: number;
            createdAt: number;
            idempotent: boolean;
        }>;
    };
    checkpointId(): string;
} {
    let checkpointId: string | null = null;
    return {
        publisher: {
            snapshot: async (event) => {
                checkpointId = event.checkpointId;
                return { id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false };
            },
        },
        checkpointId: () => {
            if (!checkpointId) throw new Error('provider smoke did not publish a snapshot');
            return checkpointId;
        },
    };
}

async function restoreProviderEdit(input: {
    checkpointRoot: string;
    projectPath: string;
    sessionId: string;
    checkpointId: string;
}): Promise<void> {
    const binding = {
        sessionId: input.sessionId,
        projectId: 'provider-smoke-project',
        worktreeId: null,
        projectPath: input.projectPath,
    } as const;
    const plan = await new CheckpointRestorePlanner(input.checkpointRoot).plan({
        ...binding,
        checkpointId: input.checkpointId,
    });
    expect(plan.entries).toContainEqual({
        path: 'provider-smoke.txt',
        action: 'delete',
        reason: 'agent-created',
    });

    await expect(new CheckpointRestoreExecutor(input.checkpointRoot).execute({
        ...binding,
        operationId: randomUUID(),
        plan,
        confirmed: true,
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(readFile(join(input.projectPath, 'provider-smoke.txt'), 'utf8'))
        .rejects.toMatchObject({ code: 'ENOENT' });
}
