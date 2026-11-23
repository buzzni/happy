import { createHash, createPublicKey, verify } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { z } from 'zod';
import { auth } from '@/app/auth/auth';
import type { WorkMachineExecutionClaims } from '@/app/auth/workMachineExecutionToken';
import { requireAccountPrincipal } from '@/app/api/utils/enableAuthentication';
import type { Fastify } from '@/app/api/types';
import {
    admitWorkMachineMcpCall, authorizeWorkMachineExecution, authorizeWorkMachineSession, drainWorkMachineExecution,
    enrollWorkMachineExecution, finishWorkMachineMcpCall, freezeDrainedWorkMachineExecution, handoffWorkMachineExecution,
    listOpenWorkMachineAutomationRuns, lockWorkMachineExecution, permitWorkMachineExecution, reconcileWorkMachineMcpCall,
    redeemWorkMachineRenewal, resumeWorkMachineExecution, type WorkMachineHandoff,
} from '@/app/machine/workMachineExecution';
import { decodeMachineDataKeyEnvelope, MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH } from '@/app/machine/machineDataKeyEnvelope';
import { buildUpdateMachineUpdate, eventRouter } from '@/app/events/eventRouter';
import { allocateUserSeq } from '@/storage/seq';
import { inTx } from '@/storage/inTx';
import { randomKeyNaked } from '@/utils/randomKeyNaked';
import type { ControlAssertionVerifier, ControlOperation } from '@/app/managed/managedControlAssertion';
import { db } from '@/storage/db';

const identifier = z.string().min(1).max(200).refine(value => value.trim() === value && !value.includes(':'));
const renewalLifetimeMs = 30_000;
const grantLifetimeMs = 5 * 60_000;
// The replacement signs at import and Studio forwards the proof at switch, which
// an operator may take hours to reach. The proof names one generation, so it
// cannot be used again once the handoff moves past it.
const handoffProofLifetimeMs = 24 * 60 * 60_000;
const maxOpenMcpCalls = 50;
const maxOpenAutomationRuns = 50;
const deviceIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const generationSchema = z.number().int().min(1).max(2_147_483_647);
const deviceSignatureSchema = z.object({
    issuedAt: z.number().int().positive(),
    publicKey: z.string().regex(/^[a-zA-Z0-9_-]{59}$/),
    signature: z.string().regex(/^[a-zA-Z0-9_-]{86}$/),
}).strict();
const renewalSchema = deviceSignatureSchema.extend({
    accountId: identifier,
    deviceId: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
    generation: z.number().int().min(1).max(2_147_483_647),
    sessionId: identifier.optional(),
    nonce: z.string().uuid(),
}).strict();

function verifyDeviceSignature(
    deviceId: string, proof: z.infer<typeof deviceSignatureSchema>,
    scope: readonly (string | number | null | readonly string[])[], now: number, lifetimeMs: number,
): boolean {
    const { issuedAt, publicKey, signature } = proof;
    if (issuedAt > now + 5_000 || issuedAt + lifetimeMs <= now) return false;
    const der = Buffer.from(publicKey, 'base64url');
    if (createHash('sha256').update(der).digest('base64url') !== deviceId) return false;
    try {
        const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
        if (key.asymmetricKeyType !== 'ed25519') return false;
        const message = Buffer.from(JSON.stringify(scope));
        return verify(null, message, key, Buffer.from(signature, 'base64url'));
    } catch {
        return false;
    }
}

export function workMachineExecutionRoutes(app: Fastify, getVerifier: () => ControlAssertionVerifier | null) {
    function verifiedOperation(
        headers: IncomingHttpHeaders, machineId: string, operation: ControlOperation, body: Record<string, unknown>, now: number,
    ): boolean {
        const assertion = headers['x-happy-control-assertion'];
        const bearer = headers.authorization?.slice(7);
        if (typeof assertion !== 'string' || !bearer) return false;
        return getVerifier()?.verify({
            assertion, operation, now,
            body: { machineId, accountTokenDigest: createHash('sha256').update(bearer).digest('hex'), ...body },
        }).ok ?? false;
    }

    app.post('/v1/work-machines/:machineId/execution-state', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: { params: z.object({ machineId: identifier }), body: z.object({}).strict() },
    }, async (request, reply) => {
        const { machineId } = request.params;
        if (!verifiedOperation(request.headers, machineId, 'work-machine-execution-state', request.body, Date.now())) {
            return reply.code(403).send({ error: 'Work machine authority lookup not authorized' });
        }
        const machine = await db.machine.findFirst({
            where: { id: machineId, accountId: request.userId },
            select: { workMachineExecution: { select: {
                deviceId: true, generation: true, drainingAt: true, frozenAt: true, firstExecutionAt: true,
                mcpCalls: {
                    where: { completedAt: null }, orderBy: { admittedAt: 'asc' }, take: maxOpenMcpCalls,
                    select: { requestId: true, admittedAt: true },
                },
            } } },
        });
        if (!machine) return reply.code(404).send({ error: 'Work machine not found' });
        const authority = machine.workMachineExecution;
        const openAutomationRuns = authority
            ? await listOpenWorkMachineAutomationRuns(db, { accountId: request.userId, machineId }, new Date(), maxOpenAutomationRuns)
            : [];
        return reply.header('Cache-Control', 'no-store').send(authority
            ? {
                mode: 'device', deviceId: authority.deviceId, generation: authority.generation,
                frozen: authority.frozenAt !== null, draining: authority.drainingAt !== null,
                firstExecution: authority.firstExecutionAt !== null,
                openMcpCalls: authority.mcpCalls.map(call => ({ requestId: call.requestId, admittedAt: call.admittedAt.getTime() })),
                openAutomationRuns: openAutomationRuns.map(run => ({ kind: run.kind, id: run.id, claimedAt: run.claimedAt.getTime() })),
            }
            : { mode: 'legacy' });
    });

    app.post('/v1/sessions/:sessionId/work-machine-permit', {
        schema: {
            params: z.object({ sessionId: identifier }),
            // `start`: the session process is starting without a turn of its own (resume, recovery). It is
            // checked like new work but records no first execution; its first turn asks again without it.
            body: z.object({ start: z.literal(true).optional() }).strict().nullish(),
        },
        bodyLimit: 1_024,
    }, async (request, reply) => {
        const bearer = request.headers.authorization?.match(/^Bearer (wmx_\S+)$/)?.[1];
        const now = Date.now();
        const claims = bearer && await auth.workMachineExecutionIssuer?.verify(bearer, 'session', now);
        if (!claims || claims.purpose !== 'session' || claims.sessionId !== request.params.sessionId) {
            return reply.code(403).send({ error: 'Work machine execution not authorized' });
        }
        const allowed = await db.$transaction(async tx => {
            // Check the session before recording first execution. The permit
            // checks the live generation again under the authority row lock.
            if (!await authorizeWorkMachineSession(tx, claims)) return false;
            if (request.body?.start) return lockWorkMachineExecution(tx, claims, { newWork: true });
            return permitWorkMachineExecution(tx, claims, new Date());
        });
        if (!allowed) return reply.code(403).send({ error: 'Work machine execution not authorized' });
        return reply.header('Cache-Control', 'no-store').code(204).send();
    });

    app.post('/v1/work-machines/mcp-mint-state', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: { body: z.object({ targetMachineId: identifier.optional() }).strict() },
        bodyLimit: 2_048,
    }, async (request, reply) => {
        if (!verifiedOperation(request.headers, 'mcp-mint-state', 'work-machine-mcp-mint-state', request.body, Date.now())) {
            return reply.code(403).send({ error: 'Work machine mint state lookup not authorized' });
        }
        const accountId = request.userId;
        const { targetMachineId } = request.body;
        const target = targetMachineId ? await db.workMachineExecution.findFirst({
            where: { accountId, machineId: targetMachineId },
            select: { machineId: true, deviceId: true, generation: true, frozenAt: true },
        }) : null;
        const fenced = target !== null || !!await db.workMachineExecution.findFirst({
            where: { accountId }, select: { machineId: true },
        });
        const response = target
            ? { fenced, target: { accountId, machineId: target.machineId, deviceId: target.deviceId,
                generation: target.generation, frozen: target.frozenAt !== null } }
            : { fenced };
        return reply.header('Cache-Control', 'no-store').send(response);
    });

    app.post('/v1/work-machines/:machineId/mcp-execution-scope', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: {
            params: z.object({ machineId: identifier }),
            body: z.object({
                sessionId: identifier,
                executionToken: z.string().startsWith('wmx_').min(5).max(4096),
            }).strict(),
        },
        bodyLimit: 5_120,
    }, async (request, reply) => {
        const { machineId } = request.params;
        const now = Date.now();
        const denied = () => reply.code(403).send({ error: 'Work machine MCP scope not authorized' });
        if (!verifiedOperation(request.headers, machineId, 'work-machine-mcp-execution-scope', request.body, now)) return denied();
        const { executionToken, sessionId } = request.body;
        const issuer = auth.workMachineExecutionIssuer;
        if (!issuer) return reply.code(503).send({ error: 'Work machine credentials unavailable' });
        const claims = await issuer.verify(executionToken, 'session', now);
        if (!claims || claims.purpose !== 'session' || claims.accountId !== request.userId
            || claims.machineId !== machineId || claims.sessionId !== sessionId
            || !await authorizeWorkMachineSession(db, claims)) return denied();
        const { accountId, deviceId, generation } = claims;
        return reply.header('Cache-Control', 'no-store').send({ accountId, machineId, deviceId, generation });
    });

    // Studio checks a daemon credential presented to it here: the current
    // device and generation of this machine, draining included, not frozen.
    app.post('/v1/work-machines/:machineId/daemon-execution-scope', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: {
            params: z.object({ machineId: identifier }),
            body: z.object({ executionToken: z.string().startsWith('wmx_').min(5).max(4096) }).strict(),
        },
        bodyLimit: 5_120,
    }, async (request, reply) => {
        const { machineId } = request.params;
        const now = Date.now();
        const denied = () => reply.code(403).send({ error: 'Work machine daemon scope not authorized' });
        if (!verifiedOperation(request.headers, machineId, 'work-machine-daemon-execution-scope', request.body, now)) return denied();
        const issuer = auth.workMachineExecutionIssuer;
        if (!issuer) return reply.code(503).send({ error: 'Work machine credentials unavailable' });
        const claims = await issuer.verify(request.body.executionToken, 'daemon', now);
        if (!claims || claims.purpose !== 'daemon' || claims.accountId !== request.userId || claims.machineId !== machineId
            || !await authorizeWorkMachineExecution(db, claims)) return denied();
        const { accountId, deviceId, generation } = claims;
        return reply.header('Cache-Control', 'no-store').send({ accountId, machineId, deviceId, generation });
    });

    for (const action of ['admit', 'finish'] as const) {
        const operation = action === 'admit' ? 'work-machine-mcp-admit' : 'work-machine-mcp-finish';
        app.post(`/v1/work-machines/:machineId/mcp-${action}`, {
            preHandler: [app.authenticate, requireAccountPrincipal],
            schema: {
                params: z.object({ machineId: identifier }),
                body: z.object({
                    accountId: identifier,
                    deviceId: identifier,
                    generation: z.number().int().min(1).max(2_147_483_647),
                    requestId: z.string().uuid(),
                }).strict(),
            },
            bodyLimit: 2_048,
        }, async (request, reply) => {
            const { machineId } = request.params;
            const rejected = () => reply.code(403).send({ error: 'Work machine connector call not authorized' });
            if (!verifiedOperation(request.headers, machineId, operation, request.body, Date.now())) return rejected();
            const { accountId, deviceId, generation, requestId } = request.body;
            if (accountId !== request.userId) return rejected();
            const scope = { accountId, machineId, deviceId, generation };
            if (action === 'admit') {
                if (!await admitWorkMachineMcpCall(db, scope, requestId)) return rejected();
            } else {
                await finishWorkMachineMcpCall(db, scope, requestId);
            }
            return reply.header('Cache-Control', 'no-store').code(204).send();
        });
    }

    app.post('/v1/work-machines/:machineId/execution-enrollment', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: {
            params: z.object({ machineId: identifier }),
            body: z.object({
                deviceId: z.string().regex(/^[a-zA-Z0-9_-]{43}$/),
                ownerUserId: identifier,
                sessionIds: z.array(identifier).max(5000),
                // Studio's records place these inventory sessions on this machine
                // for this owner. Covered by the control assertion, not the device proof.
                studioAttributedSessionIds: z.array(identifier).max(5000).optional(),
                proof: deviceSignatureSchema,
            }).strict(),
        },
    }, async (request, reply) => {
        const { machineId } = request.params;
        const { deviceId, proof, ownerUserId, sessionIds, studioAttributedSessionIds } = request.body;
        const now = Date.now();
        const enrollmentScope = ['happy-work-machine-enrollment-v2', machineId, deviceId, proof.issuedAt, [...sessionIds].sort()] as const;
        if (!verifiedOperation(request.headers, machineId, 'work-machine-enroll', request.body, now)
            || !verifyDeviceSignature(deviceId, proof, enrollmentScope, now, grantLifetimeMs)) {
            return reply.code(403).send({ error: 'Work machine enrollment not authorized' });
        }
        const enrolled = await enrollWorkMachineExecution(db, {
            machineId, accountId: request.userId, deviceId, ownerUserId, sessionIds, studioAttributedSessionIds,
        });
        if ('reason' in enrolled) return reply.code(409).send({ error: 'Work machine enrollment not ready', ...enrolled });
        return reply.header('Cache-Control', 'no-store').send(enrolled);
    });

    app.post('/v1/work-machines/:machineId/execution-renewal', {
        schema: { params: z.object({ machineId: identifier }), body: renewalSchema },
        bodyLimit: 2_048,
    }, async (request, reply) => {
        const now = Date.now();
        const { machineId } = request.params;
        const { accountId, deviceId, generation, sessionId, issuedAt, nonce } = request.body;
        const scope = { accountId, machineId, deviceId, generation };
        const issuer = auth.workMachineExecutionIssuer;
        if (!issuer) return reply.code(503).send({ error: 'Work machine credentials unavailable' });
        const proofScope = ['happy-work-machine-renew-v1', accountId, machineId, deviceId, generation, sessionId ?? null, issuedAt, nonce];
        if (!verifyDeviceSignature(deviceId, request.body, proofScope, now, renewalLifetimeMs)
            || !await redeemWorkMachineRenewal(db, { ...scope, sessionId }, {
            nonce, expiresAt: new Date(issuedAt + renewalLifetimeMs),
        })) return reply.code(403).send({ error: 'Work machine grant not authorized' });

        const expiresAt = now + grantLifetimeMs;
        const claims: WorkMachineExecutionClaims = sessionId
            ? { ...scope, sessionId, expiresAt, purpose: 'session' }
            : { ...scope, expiresAt, purpose: 'daemon' };
        return reply.header('Cache-Control', 'no-store').send({ token: await issuer.mint(claims, now), expiresAt });
    });

    const transitions = {
        drain: drainWorkMachineExecution,
        freeze: freezeDrainedWorkMachineExecution,
        resume: resumeWorkMachineExecution,
    } as const;
    for (const action of ['drain', 'freeze', 'resume'] as const) {
        app.post(`/v1/work-machines/:machineId/execution-${action}`, {
            preHandler: [app.authenticate, requireAccountPrincipal],
            schema: {
                params: z.object({ machineId: identifier }),
                body: z.object({ deviceId: deviceIdSchema, generation: generationSchema }).strict(),
            },
            bodyLimit: 1_024,
        }, async (request, reply) => {
            const { machineId } = request.params;
            if (!verifiedOperation(request.headers, machineId, `work-machine-${action}`, request.body, Date.now())) {
                return reply.code(403).send({ error: 'Work machine transition not authorized' });
            }
            const state = await transitions[action](db, { accountId: request.userId, machineId, ...request.body });
            if (typeof state === 'string') return reply.code(409).send({ error: 'Work machine transition not ready', reason: state });
            return reply.header('Cache-Control', 'no-store').send(state);
        });
    }

    const handoffs = {
        replace: { nextDevice: 'replacementDeviceId', scope: 'happy-work-machine-replace-v1' },
        restore: { nextDevice: 'originalDeviceId', scope: 'happy-work-machine-restore-v1' },
    } as const;
    for (const kind of ['replace', 'restore'] as const satisfies readonly WorkMachineHandoff[]) {
        const { nextDevice, scope } = handoffs[kind];
        app.post(`/v1/work-machines/:machineId/execution-${kind}`, {
            preHandler: [app.authenticate, requireAccountPrincipal],
            schema: {
                params: z.object({ machineId: identifier }),
                body: z.object({
                    deviceId: deviceIdSchema,
                    generation: generationSchema,
                    [nextDevice]: deviceIdSchema,
                    dataEncryptionKey: z.string().max(MACHINE_DATA_KEY_ENVELOPE_BASE64_LENGTH),
                    proof: deviceSignatureSchema,
                }).strict(),
            },
            bodyLimit: 2_048,
        }, async (request, reply) => {
            const { machineId } = request.params;
            const { deviceId, generation, dataEncryptionKey, proof } = request.body as {
                deviceId: string; generation: number; dataEncryptionKey: string; proof: z.infer<typeof deviceSignatureSchema>;
            };
            const nextDeviceId = (request.body as Record<string, string>)[nextDevice];
            const key = decodeMachineDataKeyEnvelope(dataEncryptionKey);
            if (!key) return reply.code(400).send({ error: 'invalid-data-encryption-key-envelope' });
            const now = Date.now();
            // The next device signs the exact envelope bytes it made, so the
            // control plane cannot pair its proof with a different key.
            const keyDigest = createHash('sha256').update(key).digest('base64url');
            const proofScope = [scope, machineId, generation, nextDeviceId, keyDigest, proof.issuedAt];
            if (!verifiedOperation(request.headers, machineId, `work-machine-${kind}`, request.body, now)
                || !verifyDeviceSignature(nextDeviceId, proof, proofScope, now, handoffProofLifetimeMs)) {
                return reply.code(403).send({ error: 'Work machine handoff not authorized' });
            }
            const accountId = request.userId;
            const result = await inTx(tx => handoffWorkMachineExecution(
                tx, kind, { accountId, machineId, deviceId, generation }, nextDeviceId, key,
            ));
            if ('refused' in result) return reply.code(409).send({ error: 'Work machine handoff not ready', reason: result.refused });
            if (result.changed) {
                const { metadata, metadataVersion, daemonState, daemonStateVersion } = result.machine;
                const payload = buildUpdateMachineUpdate(machineId, await allocateUserSeq(accountId), randomKeyNaked(12),
                    { value: metadata, version: metadataVersion },
                    daemonState === null ? undefined : { value: daemonState, version: daemonStateVersion });
                eventRouter.emitUpdate({ userId: accountId, payload, recipientFilter: { type: 'user-scoped-only' } });
                eventRouter.emitUpdate({ userId: accountId, payload, recipientFilter: { type: 'machine-scoped-only', machineId } });
            }
            return reply.header('Cache-Control', 'no-store').send({ deviceId: nextDeviceId, generation: generation + 1 });
        });
    }

    app.post('/v1/work-machines/:machineId/mcp-reconcile', {
        preHandler: [app.authenticate, requireAccountPrincipal],
        schema: {
            params: z.object({ machineId: identifier }),
            body: z.object({ deviceId: deviceIdSchema, generation: generationSchema, requestId: z.string().uuid() }).strict(),
        },
        bodyLimit: 1_024,
    }, async (request, reply) => {
        const { machineId } = request.params;
        if (!verifiedOperation(request.headers, machineId, 'work-machine-mcp-reconcile', request.body, Date.now())) {
            return reply.code(403).send({ error: 'Work machine connector reconcile not authorized' });
        }
        const { deviceId, generation, requestId } = request.body;
        const result = await db.$transaction(tx => reconcileWorkMachineMcpCall(
            tx, { accountId: request.userId, machineId, deviceId, generation }, requestId,
        ));
        if (result === 'not-frozen') return reply.code(409).send({ error: 'Work machine is not frozen', reason: 'not-frozen' });
        if (result === 'not-found') return reply.code(404).send({ error: 'Work machine connector call not found' });
        return reply.header('Cache-Control', 'no-store').send({ requestId, reconciledAt: result.reconciledAt?.getTime() ?? null });
    });
}
