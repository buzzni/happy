import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLessonReviewOutcomeStore, createLessonSettingsStore } from './lessonSettingsStore';

describe('createLessonReviewOutcomeStore', () => {
    it('keeps the refusal reason next to the outcome without changing what read() reports', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lesson-outcome-'));
        const path = join(dir, 'p1.outcome.json');
        const store = createLessonReviewOutcomeStore(path, () => 1_000);

        await store.record('not-eligible', 'no-signal');

        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ outcome: 'not-eligible', reason: 'no-signal', at: 1_000 });
        expect(await store.read()).toBe('not-eligible');
        await rm(dir, { recursive: true, force: true });
    });
});

describe('createLessonSettingsStore lock left behind', () => {
    const owner = (pid: number) => JSON.stringify({ version: 1, pid, startedAt: Date.now(), token: randomUUID(), acquiredAt: Date.now() });
    const values = { expectedRevision: 1, recallEnabled: false, reviewEnabled: false, dailyMicroUsd: 0, dailyTokens: 0 };

    it('reclaims the lock of a writer that crashed and saves the settings', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lesson-settings-'));
        const path = join(dir, 'settings.json');
        const crashed = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
        await new Promise(resolve => crashed.once('exit', resolve));
        await writeFile(`${path}.lock`, owner(crashed.pid!));

        const written = await createLessonSettingsStore(path).write(values);

        expect(written).toMatchObject({ ok: true, settings: { revision: 2, recallEnabled: false } });
        expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ revision: 2, recallEnabled: false });
        await rm(dir, { recursive: true, force: true });
    });

    it('reports settings_busy, not runtime_error, while a live writer holds the lock', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lesson-settings-'));
        const path = join(dir, 'settings.json');
        const live = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        try {
            await new Promise(resolve => live.once('spawn', resolve));
            await writeFile(`${path}.lock`, owner(live.pid!));
            expect(await createLessonSettingsStore(path).write(values)).toEqual({ ok: false, reason: 'settings_busy' });
            await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            live.kill();
            await rm(dir, { recursive: true, force: true });
        }
    });

    it('still reports a stale revision as revision_conflict', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'lesson-settings-'));
        const path = join(dir, 'settings.json');
        const store = createLessonSettingsStore(path);
        expect(await store.write(values)).toMatchObject({ ok: true });
        expect(await store.write(values)).toEqual({ ok: false, reason: 'revision_conflict' });
        await rm(dir, { recursive: true, force: true });
    });
});
