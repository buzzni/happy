import { describe, expect, it } from 'vitest';

import { resolveSessionMemoryScope } from './memoryScope';

describe('resolveSessionMemoryScope', () => {
    it('keeps an isolated run out of project recall and ingest even with a valid project binding', () => {
        expect(resolveSessionMemoryScope({
            env: { HAPPY_CHECKPOINT_SPAWN_CONTEXT: JSON.stringify({ schemaVersion: 1,
                projectId: 'project-a', worktreeId: 'worktree-a', checkpointRoot: '/private/checkpoint' }) },
            projectPath: '/private/project-a', sessionId: 'automation-run:run-a',
        })).toEqual({ kind: 'session', scopeId: 'automation-run:run-a' });
    });

    it('uses the authenticated project binding for project sessions', () => {
        expect(resolveSessionMemoryScope({
            env: {
                HAPPY_CHECKPOINT_SPAWN_CONTEXT: JSON.stringify({
                    schemaVersion: 1,
                    projectId: 'project-a',
                    worktreeId: 'worktree-a',
                    checkpointRoot: '/private/checkpoint',
                }),
            },
            projectPath: '/private/project-a',
            sessionId: 'session-a',
        })).toEqual({
            kind: 'project',
            scopeId: 'project-a',
            projectPath: '/private/project-a',
        });
    });

    it('keeps an unbound chat session ephemeral instead of treating cwd as a project', () => {
        expect(resolveSessionMemoryScope({
            env: {},
            projectPath: '/private/chats/chat-a',
            sessionId: 'session-a',
        })).toEqual({ kind: 'session', scopeId: 'session-a' });
    });

    it('fails closed when the inherited project binding is malformed', () => {
        expect(resolveSessionMemoryScope({
            env: { HAPPY_CHECKPOINT_SPAWN_CONTEXT: '{"projectId":"spoofed"}' },
            projectPath: '/private/chats/chat-a',
            sessionId: 'session-a',
        })).toEqual({ kind: 'session', scopeId: 'session-a' });
    });
});
