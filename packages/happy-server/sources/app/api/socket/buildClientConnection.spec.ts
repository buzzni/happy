import { describe, expect, it } from 'vitest';
import { buildClientConnection } from './buildClientConnection';

function socketWith(data: Record<string, unknown>) {
    return { data } as any;
}

describe('buildClientConnection', () => {
    it('shouldBuildASessionScopedConnectionWhenTheSessionIdIsPresent', () => {
        const connection = buildClientConnection(socketWith({ userId: 'u1', clientType: 'session-scoped', sessionId: 's1' }));
        expect(connection).toMatchObject({ connectionType: 'session-scoped', userId: 'u1', sessionId: 's1' });
    });

    it('shouldBuildAMachineScopedConnectionWhenTheMachineIdIsPresent', () => {
        const connection = buildClientConnection(socketWith({ userId: 'u1', clientType: 'machine-scoped', machineId: 'm1' }));
        expect(connection).toMatchObject({ connectionType: 'machine-scoped', userId: 'u1', machineId: 'm1' });
    });

    it.each([undefined, 'user-scoped', 'something-newer'])('shouldFallBackToUserScopedForClientType %s', (clientType) => {
        const connection = buildClientConnection(socketWith({ userId: 'u1', clientType, happyClient: 'desktop' }));
        expect(connection).toMatchObject({ connectionType: 'user-scoped', userId: 'u1', happyClient: 'desktop' });
    });
});

describe('buildClientConnection transport-only flag', () => {
    it('shouldMarkAUserScopedConnectionTransportOnlyWhenTheSocketAskedForIt', () => {
        const connection = buildClientConnection(socketWith({ userId: 'u1', clientType: 'user-scoped', transportOnly: true }));
        expect(connection).toMatchObject({ connectionType: 'user-scoped', transportOnly: true });
    });

    it('shouldIgnoreTheTransportOnlyFlagUnlessItIsExactlyTrue', () => {
        const connection = buildClientConnection(socketWith({ userId: 'u1', clientType: 'user-scoped', transportOnly: 'yes' }));
        expect(connection).not.toHaveProperty('transportOnly', true);
    });

    it('shouldNotCarryTheTransportOnlyFlagOntoSessionOrMachineConnections', () => {
        const session = buildClientConnection(socketWith({ userId: 'u1', clientType: 'session-scoped', sessionId: 's1', transportOnly: true }));
        const machine = buildClientConnection(socketWith({ userId: 'u1', clientType: 'machine-scoped', machineId: 'm1', transportOnly: true }));
        expect(session).not.toHaveProperty('transportOnly');
        expect(machine).not.toHaveProperty('transportOnly');
    });
});
