import { describe, expect, it, vi } from 'vitest';
import { createLessonTurnHost, type LessonTurnHostDeps } from './lessonTurnHost';
import type { LessonDeliveryTicket } from './lessonTurnHost';

const identity = { projectId: 'p', userId: 'u', machineId: 'm', sessionId: 's' };
const verified = { ...identity, projectHash: 'project-hash', actorId: 'user:u', generation: 1, capabilities: ['lesson.read'] as const };
const lesson = { lessonId: 'l', revision: 1, name: 'Check ports', trigger: 'Port already bound', steps: ['Inspect the listener'], validation: ['Probe the port'], failureModes: [], reconsiderWhen: 'The listener changes' };
const settings = { revision: 1, recallEnabled: true, reviewEnabled: false, dailyMicroUsd: 0, dailyTokens: 0 };

function fixture() {
    const deps = {
        host: { projectHash: verified.projectHash, close: vi.fn(), hashCandidatePayload: vi.fn(), service: {
            recall: vi.fn().mockResolvedValue({ outcome: 'selected', traceId: 'trace', lessonIds: ['l'], lessons: [lesson] }),
            ackDelivery: vi.fn().mockResolvedValue({ outcome: 'delivered', traceId: 'trace' }),
        } },
        issuer: { issue: vi.fn().mockResolvedValue({ handle: {}, release: vi.fn() }), resolve: vi.fn().mockResolvedValue(verified) },
        settings: { read: vi.fn().mockResolvedValue(settings), write: vi.fn() },
        identity: () => identity,
        budgetMs: 10,
        ackBudgetMs: 10,
        onOutcome: vi.fn(),
    };
    return { deps, host: createLessonTurnHost(deps as unknown as LessonTurnHostDeps) };
}

describe('lesson input delivery boundaries', () => {
    it('bounds acknowledgement identity issuance too', async () => {
        const { deps, host } = fixture();
        const recalled = await host.recall({ turnId: 't', query: 'port already bound' });
        expect(recalled.outcome).toBe('selected');
        deps.issuer.issue.mockImplementation(() => new Promise(() => {}));
        const result = await Promise.race([
            host.acknowledge((recalled as { ticket: LessonDeliveryTicket }).ticket),
            new Promise(resolve => setTimeout(() => resolve('unbounded'), 80)),
        ]);
        expect(result).toBe(false);
        expect(deps.host.service.ackDelivery).not.toHaveBeenCalled();
    });

    it('releases a late-issued handle without starting a stale recall', async () => {
        const { deps, host } = fixture();
        const release = vi.fn();
        let complete!: (value: { handle: object; release: () => void }) => void;
        deps.issuer.issue.mockImplementation(() => new Promise(resolve => { complete = resolve; }));
        expect(await host.recall({ turnId: 't', query: 'port already bound' })).toEqual({ outcome: 'timeout' });
        complete({ handle: {}, release });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(release).toHaveBeenCalledOnce();
        expect(deps.host.service.recall).not.toHaveBeenCalled();
    });

    it('bounds identity issuance as well as retrieval', async () => {
        const { deps, host } = fixture();
        deps.issuer.issue.mockImplementation(() => new Promise(() => {}));
        const result = await Promise.race([
            host.recall({ turnId: 't', query: 'port already bound' }),
            new Promise(resolve => setTimeout(() => resolve({ outcome: 'unbounded' }), 80)),
        ]);
        expect(result).toEqual({ outcome: 'timeout' });
        expect(deps.host.service.recall).not.toHaveBeenCalled();
    });

    it('keeps the final settings read within the same deadline', async () => {
        const { deps, host } = fixture();
        deps.settings.read.mockResolvedValueOnce(settings).mockImplementation(() => new Promise(() => {}));
        expect(await host.recall({ turnId: 't', query: 'port already bound' })).toEqual({ outcome: 'timeout' });
    });

    it('preserves a store timeout rather than claiming a protocol mismatch', async () => {
        const { deps, host } = fixture();
        deps.host.service.recall.mockResolvedValue({ outcome: 'timeout' });
        expect(await host.recall({ turnId: 't', query: 'port already bound' })).toEqual({ outcome: 'timeout' });
    });

    it('does not inject a body whose ids differ from the selected ids', async () => {
        const { deps, host } = fixture();
        deps.host.service.recall.mockResolvedValue({ outcome: 'selected', traceId: 'trace', lessonIds: ['other'], lessons: [lesson] });
        expect(await host.recall({ turnId: 't', query: 'port already bound' })).toEqual({ outcome: 'runtime_error' });
    });

    it('rejects duplicate selected ids that omit another rendered lesson', async () => {
        const { deps, host } = fixture();
        deps.host.service.recall.mockResolvedValue({ outcome: 'selected', traceId: 'trace', lessonIds: ['l', 'l'], lessons: [lesson, { ...lesson, lessonId: 'other' }] });
        expect(await host.recall({ turnId: 't', query: 'port already bound' })).toEqual({ outcome: 'runtime_error' });
    });

    it('carries the full-body lookup guidance with a partial summary', async () => {
        const { deps, host } = fixture();
        deps.host.service.recall.mockResolvedValue({ outcome: 'selected', traceId: 'trace', lessonIds: ['l'], lessons: [{ ...lesson, injectionMode: 'summary', truncated: true, detailReference: 'mem-lesson-get' }] });
        const result = await host.recall({ turnId: 't', query: 'port already bound' });
        expect(result.outcome).toBe('selected');
        expect(result.outcome === 'selected' && result.block).toContain('mem-lesson-get');
    });

    it('does not claim delivery when the store rejects an acknowledgement', async () => {
        const { deps, host } = fixture();
        const recalled = await host.recall({ turnId: 't', query: 'port already bound' });
        expect(recalled.outcome).toBe('selected');
        deps.host.service.ackDelivery.mockResolvedValue({ outcome: 'invalid_ack' });
        const ticket = (recalled as { ticket: LessonDeliveryTicket }).ticket;
        expect(await host.acknowledge(ticket)).toBe(false);
        expect(deps.onOutcome).not.toHaveBeenCalledWith('delivered');
    });

    it('keeps validation in the block and rejects a selected set that cannot fit', async () => {
        const { deps, host } = fixture();
        const first = await host.recall({ turnId: 't', query: 'port already bound' });
        expect(first.outcome === 'selected' && first.block).toContain('Probe the port');
        deps.host.service.recall.mockResolvedValue({ outcome: 'selected', traceId: 'large', lessonIds: ['l', 'large'], lessons: [lesson, { ...lesson, lessonId: 'large', steps: ['x'.repeat(1600)] }] });
        expect(await host.recall({ turnId: 't2', query: 'port already bound' })).toEqual({ outcome: 'budget_exceeded' });
        expect(deps.host.service.ackDelivery).not.toHaveBeenCalled();
    });
});

describe('shortened lesson bodies', () => {
    it('tells the model how to read a reference-only body', async () => {
        const { deps, host } = fixture();
        // `reference` sends an id and a name and nothing else; without the
        // lookup guidance the model has a title it cannot act on.
        deps.host.service.recall.mockResolvedValue({
            outcome: 'selected',
            traceId: 'trace',
            lessonIds: ['l'],
            lessons: [{
                lessonId: 'l', revision: 4, name: 'Probe before binding',
                injectionMode: 'reference', detailReference: 'mem-lesson-get',
            }],
        });
        const result = await host.recall({ turnId: 't', query: 'port already bound' });
        expect(result.outcome).toBe('selected');
        const block = result.outcome === 'selected' ? result.block : '';
        expect(block).toContain('reference only');
        expect(block).toContain('mem-lesson-get');
        expect(block).toContain('l');
        expect(block).toContain('revision 4');
    });
});
