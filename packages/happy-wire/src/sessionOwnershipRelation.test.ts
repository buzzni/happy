import { describe, expect, it } from 'vitest';
import { SessionOwnershipRelationRequestSchema as Request, SessionOwnershipRelationResponseSchema as Response } from './sessionOwnershipRelation';

const request = { v: 1, callerSessionId: 'hub', machineId: 'machine-1', sessionIds: ['a', 'b'] };
const relations = { v: 1, callerAccountId: 'account-a', proof: 'personal-same-account', relations: { a: 'own', b: 'not-own' } };
const unavailable = { v: 1, callerAccountId: 'account-a', proof: null, unavailable: true };

describe('session ownership relation v1 wire', () => {
    it('accepts the request and both answer shapes without stripping data', () => {
        expect(Request.parse(request)).toEqual(request);
        expect(Request.safeParse({ ...request, sessionIds: Array.from({ length: 100 }, (_, i) => 's' + i) }).success).toBe(true);
        for (const answer of [relations, unavailable, { ...relations, proof: null, relations: { a: 'not-own' } }]) {
            expect(Response.parse(answer)).toEqual(answer);
        }
    });

    it.each([
        ['another version', { ...request, v: 2 }],
        ['no targets', { ...request, sessionIds: [] }],
        ['more than 100 targets', { ...request, sessionIds: Array.from({ length: 101 }, (_, i) => 's' + i) }],
        ['an empty id', { ...request, sessionIds: [''] }],
        ['an overlong machine id', { ...request, machineId: 'x'.repeat(129) }],
        ['a claimed account', { ...request, accountId: 'account-b' }],
    ])('rejects a request with %s', (_name, value) => {
        expect(Request.safeParse(value).success).toBe(false);
    });

    it.each([
        ['another version', { ...relations, v: 2 }],
        ['an unknown proof', { ...relations, proof: 'company-binding' }],
        ['an unknown relation', { ...relations, relations: { a: 'owner' } }],
        ['an extra field', { ...relations, accountKind: 'personal' }],
        ['relations beside unavailable', { ...unavailable, relations: {} }],
        ['a proof beside unavailable', { ...unavailable, proof: 'personal-same-account' }],
        ['no caller account', { ...relations, callerAccountId: '' }],
    ])('rejects an answer with %s', (_name, value) => {
        expect(Response.safeParse(value).success).toBe(false);
    });
});
