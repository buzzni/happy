/**
 * A protected session child asks the Happy server for its execution permit
 * before it runs (aplus-dev-studio specs/work-machine-migration plan 5.1).
 *
 * The Happy server is Fastify with its default body parsers only, so this
 * test answers the permit with a Fastify route of the same shape. The
 * migration rehearsal found every protected child refused with 415.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiClient } from '@/api/api';
import { configuration } from '@/configuration';

describe('work machine session execution permit', () => {
    let app: FastifyInstance;
    let originalUrl: string;
    const received: { sessionId: string; authorization?: string }[] = [];

    beforeEach(async () => {
        app = Fastify();
        app.post<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/work-machine-permit', { bodyLimit: 1_024 }, async (request, reply) => {
            received.push({ sessionId: request.params.sessionId, authorization: request.headers.authorization });
            return reply.code(204).send();
        });
        app.post<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/push-event', async (request, reply) => {
            received.push({ sessionId: request.params.sessionId, authorization: request.headers.authorization });
            return reply.send({ success: true, push: { status: 'sent' } });
        });
        await app.listen({ port: 0, host: '127.0.0.1' });
        originalUrl = configuration.serverUrl;
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('no address');
        (configuration as { serverUrl: string }).serverUrl = `http://127.0.0.1:${address.port}`;
    });
    afterEach(async () => {
        (configuration as { serverUrl: string }).serverUrl = originalUrl;
        received.length = 0;
        await app.close();
    });

    it('is accepted by a Fastify server with only the default body parsers', async () => {
        const initial = { token: 'wmx_session_token_for_tests', expiresAt: Date.now() + 60_000 };
        const api = ApiClient.workMachineSession({ sessionId: 'protected-session', initial, renew: async () => initial });

        await expect(api.permitWorkMachineSessionExecution()).resolves.toBeUndefined();
        expect(received).toEqual([{ sessionId: 'protected-session', authorization: 'Bearer wmx_session_token_for_tests' }]);
    });

    // The server takes only the conversation's own session credential for a protected conversation's push.
    it('sends a protected conversation\'s push with its session credential', async () => {
        const initial = { token: 'wmx_session_token_for_tests', expiresAt: Date.now() + 60_000 };
        const api = ApiClient.workMachineSession({ sessionId: 'protected-session', initial, renew: async () => initial });

        api.push().sendSessionNotification({ kind: 'done', metadata: null, data: { sessionId: 'protected-session', type: 'ready' } });

        await expect.poll(() => received).toEqual([{ sessionId: 'protected-session', authorization: 'Bearer wmx_session_token_for_tests' }]);
    });
});
