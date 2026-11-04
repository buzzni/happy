import { Readable } from 'node:stream';
import { parseCanonicalOrgSetupTokenJson } from '@slopus/happy-wire';
import { z } from 'zod';
import type { Fastify } from '../types';
import { requireAccountPrincipal } from '@/app/api/utils/enableAuthentication';
import { isServerBackedAutomationEnabled } from '@/app/automation/automationRollout';
import { createAutomationExecutionSession, automationExecutionSessionRequestSchema,
  AutomationExecutionSessionError } from '@/app/automation/automationExecutionSession';
import { ExecutionBindingError } from '@/app/session/sessionExecutionBinding';
import { listAutomationExecutionPage } from '@/app/automation/automationExecutionPage';
import { db } from '@/storage/db';

/** Registers a run-owned session; provider start remains a separate, journaled operation. */
export function automationExecutionRoutes(app: Fastify) {
  app.get('/v1/sessions/:displaySessionId/automation-runs', {
    preHandler: app.authenticate,
    schema: { params: z.strictObject({ displaySessionId: z.string().min(1).max(200) }),
      querystring: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(20),
        cursor: z.string().min(1).max(1024).nullable().default(null) }) },
  }, async (request, reply) => {
    if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
    if (!isServerBackedAutomationEnabled()) return reply.code(404).send({ error: 'feature-disabled' });
    try {
      const page = await listAutomationExecutionPage(db, request.userId, request.params.displaySessionId, request.query);
      if (!page) return reply.code(404).send({ error: 'not-found' });
      return reply.header('Cache-Control', 'no-store').send(page);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid-automation-execution-cursor') {
        return reply.code(400).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/v1/automation-runs/:runId/execution-session', {
    preParsing: async (request, _reply, payload) => {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of payload) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > (request.server.initialConfig.bodyLimit ?? 1_048_576)) {
          throw Object.assign(new Error('Request body too large'), { statusCode: 413 });
        }
        chunks.push(bytes);
      }
      const raw = Buffer.concat(chunks);
      try { parseCanonicalOrgSetupTokenJson(new TextDecoder('utf8', { fatal: true }).decode(raw)); }
      catch { throw new AutomationExecutionSessionError(400, 'Invalid automation execution JSON'); }
      return Object.assign(Readable.from([raw]), { receivedEncodedLength: size });
    },
    preHandler: app.authenticate,
    schema: { params: z.strictObject({ runId: z.string().min(1).max(160) }),
      body: automationExecutionSessionRequestSchema.omit({ runId: true }) },
  }, async (request, reply) => {
    if (request.principal?.kind !== 'account') return requireAccountPrincipal(request, reply);
    if (!isServerBackedAutomationEnabled()) return reply.code(404).send({ error: 'feature-disabled' });
    const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    try {
      const result = await createAutomationExecutionSession(request.userId, bearer,
        { ...request.body, runId: request.params.runId });
      return reply.send({ sessionId: result.session.id, displaySessionId: request.body.displaySessionId, created: result.created });
    } catch (error) {
      if (error instanceof AutomationExecutionSessionError || error instanceof ExecutionBindingError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      throw error;
    }
  });
}
