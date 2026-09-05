// specs/linux-checkpoint-enforcement-backend — Linux twin of checkpointSandbox.integration.test.ts.
// Expectations differ from macOS on purpose: bubblewrap cannot enforce glob deny patterns, so a
// glob-only new secret is written into the turn workspace and rejected at apply time instead of
// failing at write time (spec R5). Everything else must match the macOS guarantees.
import { exec } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigSchema } from '@/persistence';
import { initializeSandbox, wrapCommand } from '@/sandbox/manager';
import { CHECKPOINT_SPAWN_CONTEXT_ENV_KEY } from './checkpointSpawnContext';
import { CheckpointProtectionStateStore } from './checkpointProtectionState';
import { createCheckpointSessionComposition } from './checkpointSessionComposition';

const execAsync = promisify(exec);
const checkpointEvents = {
    snapshot: async () => ({
        id: 'event-1', seq: 1, createdAt: Date.now(), idempotent: false,
    }),
};

describe.skipIf(process.platform !== 'linux')('checkpoint Linux bubblewrap enforcement', () => {
    let projectPath: string;
    let checkpointRoot: string;
    let cleanupSandbox: (() => Promise<void>) | null;

    beforeEach(async () => {
        projectPath = await mkdtemp(join(tmpdir(), 'happy-checkpoint-linux-'));
        checkpointRoot = await mkdtemp(join(tmpdir(), 'happy-checkpoint-store-'));
        cleanupSandbox = null;
        await writeFile(join(projectPath, 'source.txt'), 'before');
        await writeFile(join(projectPath, 'large.bin'), 'x'.repeat(2048));
        await writeFile(join(projectPath, '.gitignore'), 'dependencies/\nignored-secrets/\n');
        await mkdir(join(projectPath, 'dependencies'));
        await writeFile(join(projectPath, 'dependencies', 'package.txt'), 'cached dependency');
        // git archive materializes tracked files only, so the directory needs a file to exist in the workspace
        await mkdir(join(projectPath, 'nested'));
        await writeFile(join(projectPath, 'nested', 'keep.txt'), 'keep');
    });

    afterEach(async () => {
        await cleanupSandbox?.();
        await rm(projectPath, { recursive: true, force: true });
        await rm(checkpointRoot, { recursive: true, force: true });
    });

    function compose(
        sessionId: string,
        extra: { extraWritePaths?: string[]; passthrough?: boolean } = {},
    ) {
        return createCheckpointSessionComposition({
            provider: 'codex',
            platform: 'linux',
            projectPath,
            sessionId,
            sandboxConfig: SandboxConfigSchema.parse({
                checkpointProtection: {
                    secretPatterns: ['.env*'],
                    maxFileBytes: 1024,
                    maxFiles: 100,
                    maxTotalBytes: 8192,
                    ...(extra.passthrough === false ? {} : { readOnlyPassthroughPaths: ['dependencies'] }),
                },
                extraWritePaths: extra.extraWritePaths ?? [],
                denyReadPaths: [],
                networkMode: 'blocked',
                allowLocalBinding: false,
            }),
            env: {
                [CHECKPOINT_SPAWN_CONTEXT_ENV_KEY]: JSON.stringify({
                    schemaVersion: 1,
                    projectId: 'project-linux',
                    worktreeId: null,
                    checkpointRoot,
                }),
            },
            checkpointEvents,
        });
    }

    it('R4: wrapping before the turn workspace exists (Codex connect order) still allows workspace writes', async () => {
        const composition = await compose('session-order', { passthrough: false });
        if (!composition.beforeTurn || !composition.completeTurn || !composition.sandboxConfig || !composition.providerPath) {
            throw new Error('expected protected composition');
        }
        // Operational order: Codex initializes + wraps in connect(), beforeTurn() runs later.
        cleanupSandbox = await initializeSandbox(composition.sandboxConfig, composition.providerPath);
        const prewrapped = await wrapCommand(
            `printf agent > ${shellQuote(join(composition.providerPath, 'source.txt'))}`,
        );
        const turn = await composition.beforeTurn();
        expect(turn.providerPath).toBe(composition.providerPath);

        await execAsync(prewrapped);
        await expect(readFile(join(turn.providerPath, 'source.txt'), 'utf8')).resolves.toBe('agent');
        await cleanupSandbox();
        cleanupSandbox = null;
        await expect(composition.completeTurn(async () => {})).resolves.toMatchObject({
            status: 'completed',
            entries: [{ path: 'source.txt', action: 'write', outcome: 'written' }],
        });
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent');
    });

    it('R3/R5/R7: enumerated exclusions deny at write time, glob-only secrets are rejected at apply time', async () => {
        const composition = await compose('session-main', { passthrough: false });
        if (!composition.beforeTurn || !composition.completeTurn) throw new Error('expected protected composition');
        const turn = await composition.beforeTurn();
        cleanupSandbox = await initializeSandbox(turn.sandboxConfig!, turn.providerPath);
        const ws = turn.providerPath;
        const run = async (command: string) => execAsync(await wrapCommand(command));

        // allowed write
        await run(`printf agent > ${shellQuote(join(ws, 'source.txt'))}`);
        // R3: enumerated too-large exclusion (absent from workspace) cannot be (re)created
        await expect(run(`printf changed > ${shellQuote(join(ws, 'large.bin'))}`)).rejects.toBeDefined();
        // original project is read-only via absolute path
        await expect(run(`printf bypass > ${shellQuote(join(projectPath, 'source.txt'))}`)).rejects.toBeDefined();
        // R5 (Linux-specific): glob-only new secret IS written into the workspace ...
        await run(`printf secret > ${shellQuote(join(ws, 'nested', '.env.future'))}`);
        await expect(readFile(join(ws, 'nested', '.env.future'), 'utf8')).resolves.toBe('secret');
        // ... and a gitignored new secret too
        await run(`mkdir -p ${shellQuote(join(ws, 'ignored-secrets'))} && printf s > ${shellQuote(join(ws, 'ignored-secrets', '.env.x'))}`);

        // Codex order: sandbox cleanup (reset → cleanupBwrapMountPoints) runs before freeze.
        await cleanupSandbox();
        cleanupSandbox = null;
        const result = await composition.completeTurn(async () => {});
        // R7: no mount-point artifact (large.bin etc.) shows up as an agent change
        expect(result.status).toBe('completed');
        expect(result.entries.map((entry) => [entry.path, entry.action, entry.outcome])).toEqual([
            ['nested/.env.future', 'conflict', 'conflict'],
            ['source.txt', 'write', 'written'],
        ]);
        // original: allowed write applied, secrets never reach it
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent');
        await expect(stat(join(projectPath, 'nested', '.env.future'))).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(stat(join(projectPath, 'ignored-secrets'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect((await readFile(join(projectPath, 'large.bin'), 'utf8')).length).toBe(2048);
        // pending decision recorded from turn-apply, workspace removed after completed apply
        const state = await new CheckpointProtectionStateStore(checkpointRoot).read({
            sessionId: 'session-main', projectId: 'project-linux', worktreeId: null, projectPath,
        });
        expect(state.pendingDecision).toMatchObject({
            source: 'turn-apply',
            excluded: [{ path: 'nested/.env.future', reason: 'secret' }],
        });
        await expect(stat(ws)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('R8: a read-only passthrough stays readable, unwritable and never reaches the original', async () => {
        // R3 (2026-09-05 개정): the composition drops glob and passthrough deny entries on Linux, so
        // bubblewrap starts even though the passthrough is a symlink inside the writable workspace.
        const composition = await compose('session-symlink');
        if (!composition.beforeTurn || !composition.completeTurn) throw new Error('expected protected composition');
        const turn = await composition.beforeTurn();
        const ws = turn.providerPath;
        expect(turn.sandboxConfig!.denyWritePaths.filter((entry) => /[*?[\]]/.test(entry))).toEqual([]);
        expect(turn.sandboxConfig!.denyWritePaths).not.toContain(join(ws, 'dependencies'));
        cleanupSandbox = await initializeSandbox(turn.sandboxConfig!, ws);
        const run = async (command: string) => execAsync(await wrapCommand(command));
        await expect(run(`cat ${shellQuote(join(ws, 'dependencies', 'package.txt'))}`))
            .resolves.toMatchObject({ stdout: 'cached dependency' });
        await expect(run(`printf changed > ${shellQuote(join(ws, 'dependencies', 'package.txt'))}`)).rejects.toBeDefined();
        await expect(run(`printf changed > ${shellQuote(join(ws, 'dependencies', 'new.txt'))}`)).rejects.toBeDefined();
        await expect(run(`printf changed > ${shellQuote(join(ws, 'large.bin'))}`)).rejects.toBeDefined();
        await expect(run(`ls -a ${shellQuote(ws)}`)).resolves.toMatchObject({ stdout: expect.not.stringContaining('**') });
        const attempt = await execAsync(await wrapCommand(
            `rm ${shellQuote(join(ws, 'dependencies'))} && mkdir ${shellQuote(join(ws, 'dependencies'))} `
            + `&& printf injected > ${shellQuote(join(ws, 'dependencies', 'new.txt'))} && echo REPLACED`,
        ));
        expect(attempt.stdout.trim()).toBe('REPLACED');
        await expect(readFile(join(ws, 'dependencies', 'new.txt'), 'utf8')).resolves.toBe('injected');
        await cleanupSandbox();
        cleanupSandbox = null;
        const result = await composition.completeTurn(async () => {});
        // The replaced passthrough is gitignored in the synthetic baseline, so apply never lists it as a
        // candidate: nothing is written to the original and no conflict/pending is raised (spec R8).
        expect(result.status).toBe('completed');
        await expect(readFile(join(projectPath, 'dependencies', 'package.txt'), 'utf8')).resolves.toBe('cached dependency');
        await expect(stat(join(projectPath, 'dependencies', 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readdir(join(projectPath, 'dependencies'))).toEqual(['package.txt']);
        expect(result.entries.filter((entry) => entry.path.startsWith('dependencies'))).toEqual([]);
    });

    it('R8c: extraWritePaths containing the project keeps the original read-only', async () => {
        const composition = await compose('session-overlap', { extraWritePaths: [projectPath], passthrough: false });
        if (!composition.beforeTurn || !composition.completeTurn) throw new Error('expected protected composition');
        const turn = await composition.beforeTurn();
        cleanupSandbox = await initializeSandbox(turn.sandboxConfig!, turn.providerPath);
        await expect(execAsync(await wrapCommand(
            `printf bypass > ${shellQuote(join(projectPath, 'source.txt'))}`,
        ))).rejects.toBeDefined();
        await expect(execAsync(await wrapCommand(
            `printf bypass > ${shellQuote(join(projectPath, 'brand-new.txt'))}`,
        ))).rejects.toBeDefined();
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('before');
        // glob deny entries are dropped on Linux, so no `**` mount point is ever created in the original
        expect(await readdir(projectPath)).not.toContain('**');
    });

    it('R7 (abnormal): skipping sandbox cleanup before completeTurn — observe residue', async () => {
        const composition = await compose('session-residue', { passthrough: false });
        if (!composition.beforeTurn || !composition.completeTurn) throw new Error('expected protected composition');
        const turn = await composition.beforeTurn();
        cleanupSandbox = await initializeSandbox(turn.sandboxConfig!, turn.providerPath);
        await execAsync(await wrapCommand(`printf agent > ${shellQuote(join(turn.providerPath, 'source.txt'))}`));
        const before = await readdir(turn.providerPath);
        // deliberately no cleanupSandbox() here
        const result = await composition.completeTurn(async () => {});
        // eslint-disable-next-line no-console
        console.log(`[linux-spike] residue: workspace before apply=${JSON.stringify(before)} entries=${JSON.stringify(result.entries)} status=${result.status}`);
        await expect(readFile(join(projectPath, 'source.txt'), 'utf8')).resolves.toBe('agent');
        expect((await readFile(join(projectPath, 'large.bin'), 'utf8')).length).toBe(2048);
    });
});

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}
