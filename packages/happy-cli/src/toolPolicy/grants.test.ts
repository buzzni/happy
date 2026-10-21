import { describe, expect, it } from 'vitest';
import { createPolicyGrantStore, DENIAL_MEMORY_MS, REMOTE_GRANT_TTL_MS } from './grants';

function clock(start = 1_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('policy grants', () => {
    it('keeps a conversation grant until the session ends when there is no TTL', () => {
        const time = clock();
        const store = createPolicyGrantStore({ now: time.now });
        store.grant(['app:com.apple.Notes', 'clipboard:clipboard_read']);
        time.advance(10 * 60 * 60 * 1000);
        expect(store.view().hasGrant('app:com.apple.Notes')).toBe(true);
        expect(store.view().hasGrant('clipboard:clipboard_read')).toBe(true);
        store.clear();
        expect(store.view().hasGrant('app:com.apple.Notes')).toBe(false);
    });

    it('expires a remote session grant after 30 minutes (R6)', () => {
        const time = clock();
        const store = createPolicyGrantStore({ now: time.now, grantTtlMs: REMOTE_GRANT_TTL_MS });
        store.grant(['tool:mcp__gmail__send_email']);
        time.advance(REMOTE_GRANT_TTL_MS - 1);
        expect(store.view().hasGrant('tool:mcp__gmail__send_email')).toBe(true);
        time.advance(1);
        expect(store.view().hasGrant('tool:mcp__gmail__send_email')).toBe(false);
        expect(store.list()).toEqual([]);
    });

    it('remembers a refusal for 5 minutes or until the next user message (R13)', () => {
        const time = clock();
        const store = createPolicyGrantStore({ now: time.now });
        store.recordDenial('click|com.apple.Notes');
        time.advance(DENIAL_MEMORY_MS - 1);
        expect(store.view().recentlyDenied('click|com.apple.Notes')).toBe(true);
        time.advance(1);
        expect(store.view().recentlyDenied('click|com.apple.Notes')).toBe(false);

        store.recordDenial('click|com.apple.Notes');
        store.onUserMessage();
        expect(store.view().recentlyDenied('click|com.apple.Notes')).toBe(false);
    });

    it('revokes one grant without touching the others', () => {
        const store = createPolicyGrantStore();
        store.grant(['app:a', 'app:b']);
        store.revoke('app:a');
        expect(store.list().map((record) => record.key)).toEqual(['app:b']);
    });
});
