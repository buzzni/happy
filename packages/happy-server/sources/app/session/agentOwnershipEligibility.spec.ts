import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentOwnershipEligibility } from './agentOwnershipEligibility';

describe('eligibility response size limit', () => {
    beforeEach(() => {
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_URL', 'https://studio.example/eligibility');
        vi.stubEnv('SAYCODE_AGENT_OWNERSHIP_ELIGIBILITY_TOKEN', 'test-token');
    });
    afterEach(() => vi.unstubAllEnvs());

    it('cancels an oversized stream before consuming the entire response', async () => {
        let produced = 0;
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                produced += 1024;
                controller.enqueue(new Uint8Array(1024));
                if (produced === 32 * 1024 * 1024) controller.close();
            },
            cancel,
        }, { highWaterMark: 0 });
        const read = createAgentOwnershipEligibility({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });

        expect(await read('account', 'machine')).toBe('unavailable');
        expect(cancel).toHaveBeenCalledOnce();
        expect(produced).toBe(5 * 1024);
        expect(body.locked).toBe(false);
    });

    it.each([4096, 4097])('enforces the byte boundary on a chunked %i-byte answer', async (length) => {
        const json = JSON.stringify({ eligible: true, reason: 'personal-machine' });
        const bytes = new TextEncoder().encode(json + ' '.repeat(length - json.length));
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(bytes.slice(0, 20));
                controller.enqueue(bytes.slice(20));
                controller.close();
            },
        });
        const read = createAgentOwnershipEligibility({ fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(body)) });

        expect(await read('account', 'machine')).toBe(length === 4096 ? 'eligible' : 'unavailable');
        expect(body.locked).toBe(false);
    });
});
