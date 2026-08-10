import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Fastify } from '../types';

const mocks = vi.hoisted(() => ({
    findSession: vi.fn(),
    findAutomationRun: vi.fn(),
    dispatchSessionEventPush: vi.fn(),
    emitEphemeral: vi.fn(),
}));

vi.mock('@/storage/db', () => ({
    db: {
        session: { findFirst: mocks.findSession },
        automationRun: { findFirst: mocks.findAutomationRun },
        accountPushToken: {
            upsert: vi.fn(),
            deleteMany: vi.fn(),
            findMany: vi.fn(),
        },
    },
}));
vi.mock('@/app/push/pushDispatch', () => ({ dispatchSessionEventPush: mocks.dispatchSessionEventPush }));
vi.mock('@/app/events/eventRouter', () => ({
    buildSessionEventEphemeral: vi.fn(() => ({ type: 'session-event' })),
    eventRouter: { emitEphemeral: mocks.emitEphemeral },
}));

import { pushRoutes } from './pushRoutes';

async function makeApp() {
    const app = fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.decorate('authenticate', async (request: { userId: string }) => { request.userId = 'account-1'; });
    pushRoutes(app as unknown as Fastify);
    return app;
}

async function sendDone(app: Awaited<ReturnType<typeof makeApp>>) {
    return app.inject({
        method: 'POST',
        url: '/v1/sessions/session-1/push-event',
        headers: { authorization: 'Bearer test' },
        payload: { kind: 'done', title: "It's ready!", body: 'Automation session' },
    });
}

describe('pushRoutes automation completion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.findSession.mockResolvedValue({ id: 'session-1' });
    });

    it('suppresses unread and mobile push for a server-reported SILENT automation session', async () => {
        mocks.findAutomationRun.mockResolvedValue({ id: 'run-1' });
        const response = await sendDone(await makeApp());

        expect(response.statusCode).toBe(200);
        expect(mocks.findAutomationRun).toHaveBeenCalledWith({
            where: {
                sessionId: 'session-1',
                machineAccountId: 'account-1',
                status: 'COMPLETED',
                outcome: 'SILENT',
            },
            select: { id: true },
        });
        expect(mocks.emitEphemeral).not.toHaveBeenCalled();
        expect(mocks.dispatchSessionEventPush).not.toHaveBeenCalled();
    });

    it('keeps the normal completion path for a WOKE automation session', async () => {
        mocks.findAutomationRun.mockResolvedValue(null);
        const response = await sendDone(await makeApp());

        expect(response.statusCode).toBe(200);
        expect(mocks.emitEphemeral).toHaveBeenCalledOnce();
        expect(mocks.dispatchSessionEventPush).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'account-1', sessionId: 'session-1',
        }));
    });

    it('never suppresses an attention-required event for an automation session', async () => {
        mocks.findAutomationRun.mockResolvedValue({ id: 'run-1' });
        const app = await makeApp();
        const response = await app.inject({
            method: 'POST',
            url: '/v1/sessions/session-1/push-event',
            headers: { authorization: 'Bearer test' },
            payload: { kind: 'permission', title: 'Permission request', body: 'Automation session' },
        });

        expect(response.statusCode).toBe(200);
        expect(mocks.findAutomationRun).not.toHaveBeenCalled();
        expect(mocks.emitEphemeral).toHaveBeenCalledOnce();
        expect(mocks.dispatchSessionEventPush).toHaveBeenCalledOnce();
    });
});
