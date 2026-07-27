import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from './bootstrap';
import { readState } from './io';
import { persistExplicitStep } from './persistExplicitStep';

let workspace: string;

beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'ax-explicit-step-'));
});

afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
});

describe('persistExplicitStep', () => {
    it('bootstraps a missing state file with the explicit step', async () => {
        await persistExplicitStep(workspace, 'plan');

        expect((await readState(workspace)).step).toBe('plan');
    });

    it('transitions an existing state file to the explicit step', async () => {
        await bootstrapWorkspace(workspace, 'free');

        const next = await persistExplicitStep(workspace, 'plan');

        expect(next.step).toBe('plan');
        expect(next.history.at(-1)).toMatchObject({ from: 'free', to: 'plan' });
    });

    it('does not append duplicate history when the step already matches', async () => {
        await bootstrapWorkspace(workspace, 'plan');
        const before = await readState(workspace);

        const next = await persistExplicitStep(workspace, 'plan');

        expect(next.history).toEqual(before.history);
    });
});
