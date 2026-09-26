import { describe, expect, it, vi } from 'vitest';
import { CodexBackgroundTasks } from './codexBackgroundTasks';

const task = { callId: 'cmd', command: 'vite' };
const row = { itemId: 'cmd', processId: '42', command: 'vite' };
describe('Codex background reconciliation', () => {
    it('reads all pages before publishing running tasks and clears absent tasks without claiming success', async () => {
        const request = vi.fn().mockResolvedValueOnce({ data: [row], nextCursor: 'next' })
            .mockResolvedValueOnce({ data: [{ ...row, itemId: 'other' }], nextCursor: null })
            .mockResolvedValueOnce({ data: [], nextCursor: null });
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(request, publish);
        await tracker.refresh('thread', [task]);
        expect(request.mock.calls[1][1]).toEqual({ threadId: 'thread', cursor: 'next' });
        expect(publish.mock.lastCall?.[0]).toEqual([
            expect.objectContaining({ ...task, status: 'running' }),
            expect.objectContaining({ callId: 'other', status: 'running' }),
        ]);
        await tracker.refresh('thread');
        expect(publish.mock.lastCall?.[0]).toEqual([]);
    });
    it('keeps tasks unknown when any page fails instead of publishing a partial list', async () => {
        const request = vi.fn().mockResolvedValueOnce({ data: [row], nextCursor: 'next' })
            .mockRejectedValueOnce(new Error('unsupported'));
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(request, publish);
        await tracker.refresh('thread', [task]);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish.mock.lastCall?.[0]).toEqual([expect.objectContaining({ ...task, status: 'unknown' })]);
    });
    it('does not resurrect a task completed while a list request is pending', async () => {
        let finish!: (value: unknown) => void;
        const request = vi.fn(() => new Promise(resolve => { finish = resolve; }));
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(request, publish);
        const refresh = tracker.refresh('thread', [task]);
        tracker.complete('cmd');
        finish({ data: [row], nextCursor: null });
        await refresh;
        expect(publish.mock.lastCall?.[0]).toEqual([]);
    });
    it('discards old responses after disconnect and retains unknown evidence', async () => {
        let finish!: (value: unknown) => void;
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(() => new Promise(resolve => { finish = resolve; }), publish);
        const refresh = tracker.refresh('thread', [task]);
        tracker.invalidate();
        finish({ data: [row], nextCursor: null });
        await refresh;
        expect(publish.mock.lastCall?.[0]).toEqual([expect.objectContaining({ ...task, status: 'unknown' })]);
    });
    it('treats malformed responses as unavailable, not an empty authoritative list', async () => {
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(async () => ({ data: [{ itemId: 'cmd' }] }), publish);
        await tracker.refresh('thread', [task]);
        expect(publish.mock.lastCall?.[0][0].status).toBe('unknown');
    });
});
