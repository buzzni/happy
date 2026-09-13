/**
 * The next turn of a managed session, as the child reads it (T07-L5-b).
 *
 * The server relays the sealed payload verbatim; what is inside is this
 * module's contract. Two things are decided here and nowhere else: whether the
 * payload is a turn at all, and whether this exact turn was already taken —
 * a retry of one send must not become two turns.
 */
import { describe, expect, it } from 'vitest';

import { createManagedFollowUpGate, parseManagedFollowUp } from './managedFollowUp';

describe('parseManagedFollowUp', () => {
    it('reads a text turn with its client id', () => {
        expect(parseManagedFollowUp({ localId: 'm-1', text: 'Reply PING' }))
            .toEqual({ ok: true, localId: 'm-1', text: 'Reply PING' });
    });

    it('refuses anything that is not a text turn, naming why', () => {
        expect(parseManagedFollowUp(null)).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp('Reply PING')).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp({ text: 'x' })).toEqual({ ok: false, reason: 'malformed' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: '   ' })).toEqual({ ok: false, reason: 'empty-text' });
        expect(parseManagedFollowUp({ localId: 'm-1', text: 'x'.repeat(200_001) })).toEqual({ ok: false, reason: 'text-too-long' });
    });

    it('takes only the text: a follow-up carries no options, whatever the payload claims', () => {
        // Model, mode, prompts and tools were fixed when the run was admitted.
        const parsed = parseManagedFollowUp({
            localId: 'm-1', text: 'Reply PING', meta: { model: 'other', permissionMode: 'bypassPermissions' },
        });
        expect(parsed).toEqual({ ok: true, localId: 'm-1', text: 'Reply PING' });
    });
});

describe('createManagedFollowUpGate', () => {
    it('accepts a turn once and calls the same client id a duplicate after that', () => {
        const gate = createManagedFollowUpGate();
        expect(gate.take('m-1')).toBe('accepted');
        expect(gate.take('m-1')).toBe('duplicate');
        expect(gate.take('m-2')).toBe('accepted');
    });

    it('remembers a bounded number of ids, oldest first out', () => {
        const gate = createManagedFollowUpGate({ remember: 2 });
        gate.take('a'); gate.take('b'); gate.take('c');
        expect(gate.take('a')).toBe('accepted');
        expect(gate.take('c')).toBe('duplicate');
    });
});
