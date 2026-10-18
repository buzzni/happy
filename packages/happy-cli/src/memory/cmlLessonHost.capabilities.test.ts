import { describe, expect, it } from 'vitest';
import { openLessonHost } from './cmlLessonHost';

// The candidate schema in CML is strict: update proposals may only be sent to
// an installed store that advertises them.
describe('openLessonHost lesson update capability', () => {
    const open = (capabilities: unknown) => openLessonHost({
        workspaceDir: '/repo',
        verifyBinding: () => { throw new Error('unused'); },
        load: (async () => ({
            ok: true,
            modules: {
                openLessonHostService: async () => ({ projectHash: 'h', service: {}, close: async () => {} }),
                hashLessonCandidatePayload: () => 'x',
                ...(capabilities === undefined ? {} : { LESSON_HOST_CAPABILITIES: capabilities }),
            },
        })) as never,
    });

    it('reports update support only for the exact advertised capability', async () => {
        const cases: Array<[unknown, boolean]> = [
            [{ version: 1, nativeLessonOwnerMarker: true, lessonUpdates: true }, true],
            [{ version: 1, nativeLessonOwnerMarker: true }, false],
            [{ version: 1, lessonUpdates: 'true' }, false],
            [{ version: 2, lessonUpdates: true }, false],
            [undefined, false],
        ];
        for (const [capabilities, expected] of cases) {
            const opened = await open(capabilities);
            expect(opened.ok && opened.handle.supportsLessonUpdates).toBe(expected);
        }
    });
});
