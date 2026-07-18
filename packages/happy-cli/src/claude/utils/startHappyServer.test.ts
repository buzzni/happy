import { describe, expect, it, vi } from 'vitest';
import { createChangeTitleHandler } from './startHappyServer';
import type { ApiSessionClient } from '@/api/apiSession';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

function makeFakeClient(hasTitle: boolean) {
    return {
        hasTitle: vi.fn(() => hasTitle),
        sendClaudeSessionMessage: vi.fn()
    } as unknown as ApiSessionClient;
}

describe('createChangeTitleHandler', () => {
    it('sets the title when the session has none yet', async () => {
        const client = makeFakeClient(false);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('Fix login bug');

        expect(result).toEqual({ success: true });
        expect(client.sendClaudeSessionMessage).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'summary', summary: 'Fix login bug' })
        );
    });

    it('locks the title once one already exists, ignoring later change_title calls', async () => {
        const client = makeFakeClient(true);
        const changeTitle = createChangeTitleHandler(client);

        const result = await changeTitle('A newer title the model came up with');

        expect(result.success).toBe(false);
        expect(client.sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});
