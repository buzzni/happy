import { describe, expect, it, vi } from 'vitest';
import { CodexBackgroundTasks } from './codexBackgroundTasks';

const task = { callId: 'cmd', command: 'vite' };
const row = { itemId: 'cmd', processId: '42', command: 'vite' };
describe('Codex background reconciliation', () => {
    it('requires an authoritative complete empty snapshot, not absence of displayed tasks, for writer drain', async () => {
        const request = vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValueOnce({ data: [], nextCursor: null });
        const tracker = new CodexBackgroundTasks(request, vi.fn());
        expect(tracker.confirmedEmpty).toBe(false);
        await tracker.refresh('thread');
        expect(tracker.hasTasks).toBe(false); expect(tracker.confirmedEmpty).toBe(false);
        await tracker.refresh('thread');
        expect(tracker.confirmedEmpty).toBe(true);
        tracker.invalidate();
        expect(tracker.confirmedEmpty).toBe(false);
    });
    it('keeps writer drain unconfirmed during reads, after restore, and after an outdated response', async () => {
        let finish!: (value: unknown) => void;
        const request = vi.fn().mockResolvedValueOnce({ data: [], nextCursor: null })
            .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        const tracker = new CodexBackgroundTasks(request, vi.fn());
        await tracker.refresh('thread'); expect(tracker.confirmedEmpty).toBe(true);
        const pending = tracker.refresh('thread'); expect(tracker.confirmedEmpty).toBe(false);
        tracker.restore([]); finish({ data: [], nextCursor: null }); await pending;
        expect(tracker.confirmedEmpty).toBe(false);
    });
    it('can confirm the end of the last task only after a successful full snapshot established ownership', async () => {
        const tracker = new CodexBackgroundTasks(async () => ({ data: [row], nextCursor: null }), vi.fn());
        tracker.complete('unseen'); expect(tracker.confirmedEmpty).toBe(false);
        await tracker.refresh('thread'); expect(tracker.confirmedEmpty).toBe(false);
        tracker.complete(row.itemId); expect(tracker.confirmedEmpty).toBe(true);
    });
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
    it('keeps the time a terminal was first seen across refreshes (specs/agent-background-work-panel R1)', async () => {
        let clock = 1_000;
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(async () => ({ data: [row], nextCursor: null }), publish, () => clock);
        await tracker.refresh('thread', [task]);
        clock = 9_000;
        await tracker.refresh('thread');
        expect(publish.mock.lastCall?.[0]).toEqual([expect.objectContaining({ callId: 'cmd', startedAt: 1_000 })]);
        expect(tracker.get('cmd')).toEqual(expect.objectContaining({ processId: '42' }));
    });
    it('treats malformed responses as unavailable, not an empty authoritative list', async () => {
        const publish = vi.fn();
        const tracker = new CodexBackgroundTasks(async () => ({ data: [{ itemId: 'cmd' }] }), publish);
        await tracker.refresh('thread', [task]);
        expect(publish.mock.lastCall?.[0][0].status).toBe('unknown');
    });
});
