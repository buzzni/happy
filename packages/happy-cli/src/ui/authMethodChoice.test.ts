import { describe, expect, it } from 'vitest';
import { authMethodWithoutPrompt } from './authMethodChoice';

// aplus-dev-studio-desktop specs/headless-standalone-server T15a: joining a self-hosted
// server from a script or a non-interactive SSH session must not crash in the Ink
// selector; the pairing code is printed and the owner approves it elsewhere.
describe('authMethodWithoutPrompt', () => {
    it('skips the selector and shows the pairing code when stdin is not a terminal', () => {
        expect(authMethodWithoutPrompt(false)).toBe('mobile');
        expect(authMethodWithoutPrompt(undefined)).toBe('mobile');
    });

    it('keeps the interactive selector on a terminal', () => {
        expect(authMethodWithoutPrompt(true)).toBeNull();
    });
});
