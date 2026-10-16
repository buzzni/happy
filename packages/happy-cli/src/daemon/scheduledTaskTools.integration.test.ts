import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createScheduledTaskTools } from '@/claude/utils/scheduledTaskTools';
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth';
import { SandboxConfigSchema } from '@/persistence';
import { eventually, SessionWriteScopeFixture } from '@/testing/sessionWriteScopeFixture';
import type { ScheduledManagementRequest } from '@slopus/happy-wire';

// Studio authority/bindings are a local contract fixture here; its real HTTP authorization
// and binding recovery are covered by Studio's scheduledManagementRoute/Service tests.
describe.skipIf(process.env.HAPPY_SCHEDULED_TOOLS_INTEGRATION !== '1' || !['darwin', 'linux'].includes(process.platform))('scheduled task server/daemon integration', () => {
    it('keeps concurrent registration, two deliveries and a follow-up in one encrypted conversation, then pauses and resumes', async () => {
        let fixture: SessionWriteScopeFixture;
        const projectId = `chat:scheduled-tools-fixture-${randomUUID()}`;
        let sessionId = '', machineId = '';
        const links: string[] = [], bridgeErrors: string[] = [];
        const bridge = createServer(async (req, res) => {
            const reply = (status: number, value: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
            try {
                if (req.method !== 'POST') { reply(404, {}); return; }
                let text = ''; for await (const chunk of req) text += chunk;
                const body = JSON.parse(text);
                if (!fixture.token || req.headers.authorization !== `Bearer ${fixture.token}` || body.machineId !== machineId) { reply(403, {}); return; }
                if (req.url === '/api/agent-spawn/session-link') { reply(200, { ok: true }); return; }
                if (!['/api/automation/mcp-caller-grant', '/api/automation/project-environment', '/api/automation/session-link'].includes(req.url ?? '')) { reply(404, {}); return; }
                const context = await happy('POST', `/v1/automation-runs/${encodeURIComponent(body.runId)}/mcp-context`, {
                    machineId, claimToken: body.claimToken, ...(req.url === '/api/automation/session-link' ? { sessionId: body.sessionId } : {}),
                });
                if (context.projectId !== projectId) throw new Error('Unexpected run scope');
                if (req.url === '/api/automation/mcp-caller-grant') {
                    reply(200, { projectId, grant: null, bindingStatus: 'BOUND', connectorPolicy: 'optional', requiredConnectors: [] }); return;
                }
                if (req.url === '/api/automation/project-environment') {
                    if (body.conversationSessionId !== sessionId) { reply(409, {}); return; }
                    reply(200, { projectId, environmentVariables: {}, conversationSessionId: sessionId }); return;
                }
                if (req.url === '/api/automation/session-link' && body.sessionId === sessionId) {
                    links.push(body.sessionId); reply(200, { ok: true }); return;
                }
                reply(404, {});
            } catch (error) { bridgeErrors.push(String(error)); reply(500, { error: 'FIXTURE_BRIDGE_FAILED' }); }
        });
        await new Promise<void>(resolve => bridge.listen(0, '127.0.0.1', resolve));
        fixture = new SessionWriteScopeFixture({ provider: 'codex', encryptionVariant: 'legacy', databaseUrl: process.env.HAPPY_SCHEDULED_TOOLS_DATABASE_URL,
            automationStudioUrl: `http://127.0.0.1:${(bridge.address() as { port: number }).port}` });
        async function happy(method: string, path: string, body?: unknown): Promise<any> {
            const response = await fetch(fixture.serverUrl + path, { method, headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' },
                ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
            const value = await response.json();
            if (!response.ok) throw new Error(`Fixture Happy ${method} ${path}: ${response.status} ${(value as { error?: string }).error ?? 'unknown'}`);
            return value;
        }
        try {
            await fixture.start(); await fixture.waitDaemonConnection(true);
            machineId = (await fixture.http('/v1/machines')).body[0].id;
            sessionId = await fixture.spawnSession(fixture.project, SandboxConfigSchema.parse({ sessionIsolation: 'workspace', networkMode: 'allowed' }));
            await fixture.send(sessionId, 'scope-marker-initial'); await fixture.waitReply(sessionId, 'scope-marker-initial');
            const originalIdentity = (await fixture.session(sessionId)).metadata.codexThreadId;
            await happy('POST', '/v1/projects', { id: projectId, name: 'Scheduled tools fixture', config: { machineId } });
            const base = `/v1/projects/${encodeURIComponent(projectId)}`;
            let encryptedCreate: unknown;
            const bindings = new Set<string>();
            const request = async (input: ScheduledManagementRequest): Promise<unknown> => {
                const reg = (key: string) => `${base}/automations/registrations/${encodeURIComponent(key)}`;
                if (input.operation === 'target') return (await happy('GET', `${base}/automation-target`)).target;
                if (input.operation === 'viewer_key') return happy('PUT', `${base}/automation-viewer-key`, { expectedKeyVersion: input.expectedKeyVersion, publicKey: input.publicKey });
                if (input.operation === 'get_registration') {
                    const response = await fetch(fixture.serverUrl + reg(input.registrationKey), { headers: { Authorization: `Bearer ${fixture.token}` } });
                    if (response.status === 404) return { automation: null };
                    if (!response.ok) throw new Error(`Registration read ${response.status}`);
                    return response.json();
                }
                if (input.operation === 'create') {
                    encryptedCreate = input.encrypted;
                    // Exercise real DB/Serializable HTTP races, not just a mocked createMany.
                    const concurrent = await Promise.all([happy('PUT', reg(input.registrationKey), input.encrypted), happy('PUT', reg(input.registrationKey), input.encrypted)]);
                    expect(concurrent[0].automation.id).toBe(concurrent[1].automation.id);
                    bindings.add(concurrent[0].automation.id);
                    return happy('PATCH', `${base}/automations/${concurrent[0].automation.id}`, { expectedRevision: 1, paused: false });
                }
                const rows = (await happy('GET', `${base}/automations`)).automations;
                if (input.operation === 'list') return { automations: rows };
                if (input.operation === 'get' || input.operation === 'set_paused') {
                    const row = rows.find((row: any) => row.id === input.automationId);
                    if (input.operation === 'get') return { automation: row ?? null };
                    expect(bindings.has(input.automationId)).toBe(true);
                    return happy('PATCH', `${base}/automations/${input.automationId}`, { expectedRevision: input.expectedRevision, paused: input.paused });
                }
                throw new Error('Unexpected management request');
            };
            const credentials = readLocalHappyAgentCredentials(fixture.happyHome)!;
            const tools = createScheduledTaskTools({ projectId, sessionId, machineId, directory: fixture.project, viewerKeyPair: credentials.contentKeyPair,
                request, ensureExecutionSupported: async () => {} });
            const create = { operation: 'create', registrationKey: 'scheduled-integration-request-001', name: 'Fixture check', prompt: 'Every 15 minutes provide scope-marker-reservation once', schedule: { kind: 'interval', minutes: 15 } };
            let row = await tools.execute(create) as { id: string; revision: number; paused: boolean };
            expect(row).toMatchObject({ paused: false, revision: 2, executionConfirmed: false });
            expect(await tools.execute(create)).toMatchObject({ id: row.id, revision: 2 });
            expect((await happy('GET', `${base}/automations`)).automations).toHaveLength(1);
            const waitApplied = async () => eventually(async () => {
                const current = (await happy('GET', `${base}/automations`)).automations[0];
                return current.appliedRevision === current.revision ? current : undefined;
            }, 'daemon applied schedule', 30000);
            await waitApplied();
            const run = async (count: number) => {
                await happy('POST', `${base}/automations/${row.id}/run`, { expectedRevision: row.revision });
                row = await tools.execute({ operation: 'get', automationId: row.id }) as typeof row;
                await eventually(async () => {
                    const runs = (await happy('GET', `${base}/automation-runs`)).runs;
                    const completed = runs.filter((run: any) => run.status === 'COMPLETED');
                    if (runs.some((run: any) => run.status === 'FAILED')) throw new Error(`Scheduled fixture run failed: ${JSON.stringify(runs)}`);
                    return completed.length === count ? completed : undefined;
                }, `completed reservation delivery ${count}`, 30000);
                await eventually(async () => {
                    const messages = await fixture.messages(sessionId);
                    return messages.filter(message => fixture.decode(message.content.c, sessionId)?.content?.ev?.text === 'fixture reply scope-marker-reservation').length === count ? true : undefined;
                }, `reservation reply ${count}`);
            };
            // Force due via the existing run-now API so this test does not wait two 15-minute periods.
            await run(1);
            await fixture.send(sessionId, 'scope-marker-follow-up'); await fixture.waitReply(sessionId, 'scope-marker-follow-up');
            await run(2);
            row = await tools.execute({ operation: 'set_paused', automationId: row.id, expectedRevision: row.revision, paused: true }) as typeof row;
            expect(row).toMatchObject({ paused: true, revision: 5 }); await waitApplied();
            const stopped = await fetch(fixture.serverUrl + `${base}/automations/${row.id}/run`, { method: 'POST', headers: { Authorization: `Bearer ${fixture.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: row.revision }) });
            expect(stopped.status).toBe(409);
            expect(await tools.execute(create)).toMatchObject({ id: row.id, paused: true, revision: 5 });
            row = await tools.execute({ operation: 'set_paused', automationId: row.id, expectedRevision: row.revision, paused: false }) as typeof row;
            expect(row).toMatchObject({ paused: false, revision: 6 }); await waitApplied(); await run(3);
            expect((await fixture.http('/v1/sessions')).body.sessions.map((session: any) => session.id)).toEqual([sessionId]);
            expect((await fixture.session(sessionId)).metadata.codexThreadId).toBe(originalIdentity);
            const messages = await fixture.messages(sessionId);
            expect(messages.every(message => message.content.t === 'encrypted' && fixture.decode(message.content.c, sessionId) !== null)).toBe(true);
            expect(messages.filter(message => message.localId?.startsWith('happy-automation:'))).toHaveLength(3);
            const occurrences = messages.filter(message => message.localId?.startsWith('happy-automation:')).map(message => fixture.decode(message.content.c, sessionId));
            expect(occurrences.every(message => message.content.text === create.prompt)).toBe(true);
            expect(fixture.modelRequests.some(body => body.includes('already-registered scheduled task') && body.includes('Do not create, register, or resume a schedule'))).toBe(true);
            expect((await happy('GET', `${base}/automations`)).automations).toHaveLength(1);
            expect((await happy('GET', `${base}/automations`)).automations[0].payloadCiphertext).toBe((encryptedCreate as { payloadCiphertext: string }).payloadCiphertext);
            expect(links).toEqual([sessionId, sessionId, sessionId]);
            expect(bridgeErrors).toEqual([]); expect(fixture.failures).toEqual([]);
        } catch (error) { console.error(await fixture.diagnostics()); throw error; }
        finally { try { await fixture.close(); } finally { await new Promise<void>(resolve => bridge.close(() => resolve())); } }
    }, 180000);
});
