import { describe, it, expect } from 'vitest';
import { SESSION_EVENT_TYPES } from './sessionEventTypes';

describe('SESSION_EVENT_TYPES', () => {
    it('exposes checkpoint-snapshot for file change persistence', () => {
        expect(SESSION_EVENT_TYPES.CHECKPOINT_SNAPSHOT).toBe('checkpoint-snapshot');
    });

    it('exposes checkpoint-rewind for rewind action persistence', () => {
        expect(SESSION_EVENT_TYPES.CHECKPOINT_REWIND).toBe('checkpoint-rewind');
    });

    it('includes both checkpoint types in the whitelist consumed by v3 routes', () => {
        const values = Object.values(SESSION_EVENT_TYPES);
        expect(values).toContain('checkpoint-snapshot');
        expect(values).toContain('checkpoint-rewind');
    });

    it('exposes message-hidden for conversation rewind hide markers', () => {
        expect(SESSION_EVENT_TYPES.MESSAGE_HIDDEN).toBe('message-hidden');
    });

    it('exposes message-unhidden for conversation rewind restore markers', () => {
        expect(SESSION_EVENT_TYPES.MESSAGE_UNHIDDEN).toBe('message-unhidden');
    });

    it('includes both message hide types in the whitelist consumed by v3 routes', () => {
        const values = Object.values(SESSION_EVENT_TYPES);
        expect(values).toContain('message-hidden');
        expect(values).toContain('message-unhidden');
    });
});
