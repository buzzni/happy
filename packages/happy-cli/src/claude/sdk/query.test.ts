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

    it('forwards additional directories to the Claude Agent SDK for new and resumed queries', () => {
        for (const resume of [undefined, 'claude-session-id']) {
            query({
                prompt: 'continue',
                options: {
                    additionalDirectories: ['/repo/frontend', '/repo/backend'],
                    resume,
                },
            });
        }

        expect(sdkQuery).toHaveBeenNthCalledWith(1, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: undefined,
            }),
        }));
        expect(sdkQuery).toHaveBeenNthCalledWith(2, expect.objectContaining({
            options: expect.objectContaining({
                additionalDirectories: ['/repo/frontend', '/repo/backend'],
                resume: 'claude-session-id',
            }),
        }));
    });

    it('forwards fail-closed sandbox settings to the Claude Agent SDK', () => {
        const sandbox = {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            filesystem: { denyWrite: ['/project/**/.env*'] },
        };

        query({ prompt: 'edit', options: { sandbox } });

        expect(sdkQuery).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ sandbox }),
        }));
    });
});
