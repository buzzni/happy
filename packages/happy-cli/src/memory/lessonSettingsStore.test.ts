import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createLessonReviewOutcomeStore } from './lessonSettingsStore';

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
