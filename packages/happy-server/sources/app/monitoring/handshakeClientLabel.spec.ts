import { describe, expect, it } from 'vitest';
import { rejectedHandshakeLogLabel } from './handshakeClientLabel';

// A rejected handshake used to log only "Invalid token provided", so a reconnect
// storm with a dead token could not be traced to the client that sends it.
describe('rejectedHandshakeLogLabel', () => {
    it('names the client type and the client label from auth or header', () => {
        expect(rejectedHandshakeLogLabel({ auth: { clientType: 'user-scoped', happyClient: 'web-ui-server' }, headers: {} }))
            .toBe('clientType=user-scoped client=web-ui-server');
        expect(rejectedHandshakeLogLabel({ auth: { clientType: 'machine-scoped' }, headers: { 'x-happy-client': 'cli-daemon/1.1.10-aplus.372' } }))
            .toBe('clientType=machine-scoped client=cli-daemon/1.1.10-aplus.372');
    });

    it('says unknown when the client sends nothing', () => {
        expect(rejectedHandshakeLogLabel({ auth: {}, headers: {} })).toBe('clientType=unknown client=unknown');
    });

    it('keeps untrusted values from shaping the log line', () => {
        expect(rejectedHandshakeLogLabel({
            auth: { clientType: 'user-scoped\nFAKE LINE', happyClient: 'x'.repeat(500) + '\r\n' },
            headers: {},
        })).toBe(`clientType=other client=${'x'.repeat(64)}`);
    });
});
