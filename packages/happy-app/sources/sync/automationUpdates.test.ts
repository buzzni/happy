import { describe, expect, it, vi } from 'vitest';

import { emitAutomationUpdate, subscribeAutomationUpdates } from './automationUpdates';

describe('automation update subscription', () => {
    it('notifies active clients once and stops after unsubscribe', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeAutomationUpdates(listener);
        const update = { projectId: 'project-1', automationId: 'automation-1', revision: 2, reason: 'upsert' as const };

        emitAutomationUpdate(update);
        unsubscribe();
        emitAutomationUpdate({ ...update, revision: 3 });

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener).toHaveBeenCalledWith(update);
    });
});
