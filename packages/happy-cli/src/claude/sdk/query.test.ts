import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkQuery = vi.hoisted(() => vi.fn(() => ({ mocked: true })));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: sdkQuery,
}));

import { query } from './query';

describe('query adapter', () => {
    beforeEach(() => {
        sdkQuery.mockClear();
    });

    it('forwards prompt suggestion enablement to the Claude Agent SDK', () => {
        query({
            prompt: 'continue',
            options: { promptSuggestions: true },
        });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                promptSuggestions: true,
            }),
        }));
    });
});
