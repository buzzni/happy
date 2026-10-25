import { describe, expect, it } from 'vitest';
import { RESOLVED_PERMISSION_LOG_LIMIT, ResolvedPermissionLog } from './permissionResolution';

describe('ResolvedPermissionLog', () => {
    it('tells a late answer whether the request was answered or expired', () => {
        const log = new ResolvedPermissionLog();
        log.record('a', 'answered');
        log.record('e', 'expired');
        log.record('r', 'reset');

        expect(log.ackFor('a')).toEqual({ applied: false, reason: 'already-answered' });
        expect(log.ackFor('e')).toEqual({ applied: false, reason: 'expired' });
        // Stopped, reset or never seen: the client reads the agent state's record instead.
        expect(log.ackFor('r')).toEqual({ applied: false, reason: 'unknown-request' });
        expect(log.ackFor('never')).toEqual({ applied: false, reason: 'unknown-request' });
    });

    it('forgets the oldest ids first once it holds more than the limit', () => {
        const log = new ResolvedPermissionLog();
        for (let i = 0; i <= RESOLVED_PERMISSION_LOG_LIMIT; i += 1) log.record(`id-${i}`, 'answered');

        expect(log.get('id-0')).toBeUndefined();
        expect(log.get('id-1')).toBe('answered');
        expect(log.get(`id-${RESOLVED_PERMISSION_LOG_LIMIT}`)).toBe('answered');
    });

    it('keeps a re-settled id as the newest entry', () => {
        const log = new ResolvedPermissionLog(2);
        log.record('a', 'reset');
        log.record('b', 'answered');
        log.record('a', 'expired');
        log.record('c', 'answered');

        expect(log.get('a')).toBe('expired');
        expect(log.get('b')).toBeUndefined();
    });

    it('does not read inherited object keys as settled ids', () => {
        const log = new ResolvedPermissionLog();
        expect(log.get('__proto__')).toBeUndefined();
        expect(log.ackFor('constructor')).toEqual({ applied: false, reason: 'unknown-request' });
        log.record('__proto__', 'answered');
        expect(log.ackFor('__proto__')).toEqual({ applied: false, reason: 'already-answered' });
    });
});
