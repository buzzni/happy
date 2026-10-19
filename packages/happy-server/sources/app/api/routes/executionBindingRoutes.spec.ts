import fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { expect, it, vi } from 'vitest';
import type { Fastify } from '../types';
const state = vi.hoisted(() => ({ session: {
  id: 'preexisting', seq: 0, metadata: 'encrypted', metadataVersion: 0, agentState: null,
  agentStateVersion: 0, dataEncryptionKey: null, active: true, lastActiveAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
} }));
vi.mock('@/storage/db', () => ({ db: { session: { findFirst: vi.fn(async () => state.session) } } }));
vi.mock('@/app/events/eventRouter', () => ({ eventRouter: {}, buildNewSessionUpdate: vi.fn() }));
vi.mock('@/app/session/sessionDelete', () => ({ sessionDelete: vi.fn() }));
vi.mock('@/app/session/sessionArchive', () => ({ sessionArchive: vi.fn() }));
import { sessionRoutes } from './sessionRoutes';
it('rejects a supplied malformed execution proof instead of loading an arbitrary existing session', async () => {
  const app = fastify(); app.setValidatorCompiler(validatorCompiler); app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;
  const auth = async (request: any) => { request.userId = 'owner'; request.principal = { kind: 'account', accountId: 'owner' }; };
  typed.decorate('authenticate', auth); typed.decorate('authenticateSessionScope', auth);
  sessionRoutes(typed);
  try {
    const response = await typed.inject({ method: 'POST', url: '/v1/sessions', payload: { tag: 'existing', metadata: 'encrypted', executionProof: {} } });
    expect(response.statusCode).toBe(400);
  } finally { await typed.close(); }
});
