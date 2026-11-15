import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import nacl from 'tweetnacl';
import { HappySessionExecutionProofSchema, SessionExecutionTicketBodySchema, SignedSubagentRequestSchema,
    rotationDigest, rotationSha256, sessionCreateBodyHash, sessionTagHash, signRotationDocument, verifyRotationDocument,
    verifySubagentRequest, type SessionExecutionTicket } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { createOrgSubagentRuntime, readOrgSubagentRegistration, type OrgSubagentPersisted } from './orgEndpointSubagentRuntime';
import { buildSpawnRequestEnvironment, captureSaycodeAgentEnvironment, formatOrgEndpointBinding } from './sessionEnv';
import { ORG_ENDPOINT_BINDING_ENV } from '@/utils/childEnv';
import { createNodeAiCredentialRuntime } from './aiCredentialRuntime';
import { createClaudeSwapSupervisor } from './claudeSwapSupervisor';

describe('org subagent production adapter', () => {
    it('creates an execution-bound ordinary root, org child and inherited grandchild through signed HTTP', async () => {
        const home = await mkdtemp(join(tmpdir(), 'org-runtime-'));
        const originalUrl = configuration.serverUrl;
        const device = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3)), serverKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(4));
        const keyId = await rotationSha256(serverKey.publicKey), deviceKeyId = await rotationSha256(device.publicKey);
        const records: Record<string, OrgSubagentPersisted> = {};
        const executions = new Map<string, SessionExecutionTicket['body']>();
        const operations = new Map<string, { bindingId: string; state: string; digest: string; sessionId?: string }>();
        let origin = '', sessions = 0, starts = 0, strict = false, serverSupported = false, dropReport = true, badReceipt = false;
        let credentialRuntime: ReturnType<typeof createNodeAiCredentialRuntime> | undefined;
        const syncs = { reentrant: 0, response: 0 }, probes: string[] = [];
        const sync = () => ({ version: 1, companyId: 'company', userId: 'user', endpoint: { id: 'endpoint', generation: 3, model: 'sonnet', models: {},
            maxContextTokens: 200_000, apiTimeoutMs: 60_000, authMode: 'none', targets: [{ id: 'target-a', url: origin + '/a' }, { id: 'target-b', url: origin + '/b' }] } });
        const rejected: string[] = [];
        const issue = async (request: { machineId: string; launchId: string; initialNonce: string; sessionTagHash: string; sessionCreateBodyHash: string }) =>
            signRotationDocument(SessionExecutionTicketBodySchema.parse({ version: 1, type: 'saycode-session-execution', audience: origin,
                studioOrigin: origin, keyId, companyId: 'company', machineId: request.machineId, approvalId: 'approval', deviceKeyId,
                machineOwnerAccountId: 'account', sessionOwnerAccountId: 'account', launchId: request.launchId, initialNonce: request.initialNonce,
                operationId: request.launchId, deviceSigningPublicKey: Buffer.from(device.publicKey).toString('base64url'),
                sessionTagHash: request.sessionTagHash, sessionCreateBodyHash: request.sessionCreateBodyHash, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 }), serverKey.secretKey);
        const http = createServer(async (req, res) => {
            if (req.url?.endsWith('/v1/models')) {
                probes.push(req.url); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"data":[]}'); return;
            }
            if (req.url === '/v1/org-endpoint-subagent/capabilities') {
                res.writeHead(serverSupported ? 200 : 404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ orgEndpointSubagentVersion: 1, executionProofVersion: 1, relayTimeoutMs: 630000 })); return;
            }
            try {
                const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
                const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                let result: unknown;
                if (req.url === '/v1/sessions') {
                    const proof = HappySessionExecutionProofSchema.parse(raw.executionProof);
                    await verifyRotationDocument(proof.ticket, serverKey.publicKey);
                    await verifyRotationDocument(proof.deviceProof, device.publicKey);
                    const { executionProof: _proof, ...body } = raw;
                    expect(proof.ticket.body.sessionCreateBodyHash).toBe(await sessionCreateBodyHash(body));
                    expect(proof.deviceProof.body.ticketDigest).toBe(await rotationDigest(proof.ticket));
                    const sessionId = `session-${++sessions}`; executions.set(sessionId, proof.ticket.body);
                    result = { session: { id: sessionId, seq: 0, metadata: raw.metadata, metadataVersion: 0, agentState: raw.agentState, agentStateVersion: 0 } };
                } else {
                    const signed = SignedSubagentRequestSchema.parse(raw), body = signed.body;
                    expect(body.audience).toBe(origin); expect(body.path).toBe(req.url);
                    expect(verifySubagentRequest(signed, Buffer.from(device.publicKey).toString('base64url'))).toBe(true);
                    expect(executions.get(body.sourceSessionId)?.launchId).toBe(body.launchId);
                    const operation = operations.get(body.operationId);
                    if (body.path.endsWith('/subagent-capabilities')) result = { version: 1, orgEndpointSubagentVersion: 1, proofVersion: 1 };
                    else if (body.path.endsWith('/subagent-prepare')) {
                        // Studio's out-of-band sync arrives while prepare is still awaited. No credential queue may enclose that wait.
                        if (!strict) { syncs.reentrant++; await credentialRuntime!.orgLlmEndpointSync(sync()); }
                        const current = operation ?? { bindingId: `binding-${operations.size + 1}`, state: 'prepared', digest: body.digest };
                        operations.set(body.operationId, current);
                        result = { version: 1, state: current.state, sync: sync(), selection: { kind: 'org-endpoint', bindingId: current.bindingId, endpointId: 'endpoint', generation: 3,
                            candidates: body.operationId === 'op-child' ? ['target-a', 'target-b'] : ['target-b', 'target-a'] } };
                    } else if (body.path.endsWith('/subagent-child-ticket') && 'initialNonce' in body) {
                        expect(operation?.digest).toBe(body.digest);
                        result = { version: 1, executionTicket: await issue({ machineId: body.machineId, launchId: operation!.bindingId,
                            initialNonce: body.initialNonce, sessionTagHash: body.sessionTagHash, sessionCreateBodyHash: body.sessionCreateBodyHash }) };
                    } else if (body.path.endsWith('/subagent-launching')) {
                        const authorized = operation!.state === 'prepared'; operation!.state = 'launching';
                        result = { version: 1, state: 'launching', launchAuthorized: authorized };
                    } else if (body.path.endsWith('/subagent-started') && 'sessionId' in body) {
                        expect(executions.get(body.sessionId)?.launchId).toBe(operation?.bindingId);
                        if (dropReport) { dropReport = false; res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
                        operation!.state = 'started'; operation!.sessionId = body.sessionId;
                        result = { version: 1, state: 'started', sessionId: body.sessionId };
                    } else if (body.path.endsWith('/subagent-resume')) result = { version: 1, ok: true };
                    else result = { version: 1, state: operation?.state, sessionId: operation?.sessionId };
                }
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
            } catch (error) { rejected.push(String(error)); res.writeHead(403, { 'Content-Type': 'application/json' }); res.end('{}'); }
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const address = http.address(); if (!address || typeof address === 'string') throw new Error('test address unavailable');
        origin = `http://127.0.0.1:${address.port}`; configuration.serverUrl = origin;
        try {
            const credentialHome = join(home, 'credentials'), endpointStorePath = join(credentialHome, '.happy', 'org-llm-endpoints.json');
            credentialRuntime = createNodeAiCredentialRuntime(createClaudeSwapSupervisor(join(home, 'supervisor.json')), {}, credentialHome, { machineId: 'machine' });
            const runtime = createOrgSubagentRuntime({ home, endpointStorePath, machineId: 'machine', studioOrigin: origin, happyOrigin: origin,
                keys: { signing: device, recipient: nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(7)) },
                strict: () => strict, pin: async () => ({ approval: { body: { machineType: 'dedicated' } } }), records: () => records,
                registration: async () => ({ machineId: 'machine', happyAccountId: 'account', credentials: { token: 'fixture-account', encryption: { type: 'dataKey',
                    publicKey: nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(8)).publicKey, machineKey: new Uint8Array(32).fill(9) } } }),
                metadata: options => ({ path: options.directory, host: 'test', machineId: 'machine', homeDir: home, happyHomeDir: home, happyLibDir: '/lib', happyToolsDir: '/tools' }),
                sync: async raw => { syncs.response++; return credentialRuntime!.orgLlmEndpointSync(raw); },
                environment: selection => credentialRuntime!.sessionEnvironment('claude', selection),
                persist: async (session, env) => { records[session.id] = { metadata: session.metadata, agentEnvironment: env }; return true; },
                start: async options => {
                    starts++;
                    const reconnect = options.reconnectEnvironment!; const id = reconnect.HAPPY_RECONNECT_SESSION_ID;
                    const env = { ...buildSpawnRequestEnvironment({}, options.environmentVariables, { defaultAgentRoot: options.directory }), ...reconnect };
                    const selection = options.aiAuthSelection;
                    let appliedOrgLlmEndpoint: { bindingId: string; targetId: string } | undefined;
                    if (selection && typeof selection === 'object' && 'kind' in selection && selection.kind === 'org-endpoint') {
                        const selected = selection as { bindingId: string; endpointId: string; generation: number; candidates: string[] };
                        appliedOrgLlmEndpoint = { bindingId: selected.bindingId, targetId: selected.candidates[0] };
                        Object.assign(env, { HAPPY_AI_AUTH_SOURCE: 'org-endpoint', [ORG_ENDPOINT_BINDING_ENV]: formatOrgEndpointBinding({ bindingId: selected.bindingId,
                            endpointId: selected.endpointId, generation: selected.generation, targetId: selected.candidates[0] }) });
                    }
                    records[id].agentEnvironment = captureSaycodeAgentEnvironment(env);
                    return { type: 'success' as const, sessionId: id, ...(appliedOrgLlmEndpoint ? {
                        appliedAiAuthSource: badReceipt ? 'unknown' as const : 'org-endpoint' as const, appliedOrgLlmEndpoint,
                    } : {}) };
                },
            });
            await expect(runtime.prepareRoot({ companyId: 'company', options: { directory: home, agent: 'codex' } })).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_HAPPY_SERVER_UNSUPPORTED' });
            expect(sessions).toBe(0); expect(starts).toBe(0);
            serverSupported = true;
            const prepared = await runtime.prepareRoot({ companyId: 'company', options: { directory: home, agent: 'codex', initialPrompt: 'parent' } });
            const root = await runtime.startRoot({ launchId: prepared.launchId, executionTicket: await issue(prepared.request) });
            expect(root).toMatchObject({ type: 'success', sessionId: 'session-1' });
            const context = await runtime.context({ sourceSessionId: 'session-1', checkServer: true });
            expect(context).toMatchObject({ proofAvailable: true, serverStatus: 'supported', source: { kind: 'default' } });
            const childInput = { operationId: 'op-child', spawnId: 'agent-child', sourceSessionId: 'session-1', endpointId: 'endpoint', directory: home, agent: 'claude', initialPrompt: 'child' };
            const child = await runtime.spawn(childInput);
            expect(child).toMatchObject({ ok: false, error: 'spawn_pending' });
            expect(starts).toBe(2);
            expect(await runtime.context({ sourceSessionId: 'session-2', checkServer: true })).toMatchObject({ source: { kind: 'org-endpoint' }, serverStatus: 'supported' });
            expect(await runtime.status({ sourceSessionId: 'session-1', operationId: 'op-child' })).toMatchObject({ ok: true, sessionId: 'session-2' });
            const grandchildInput = { operationId: 'op-grandchild', spawnId: 'agent-grandchild', sourceSessionId: 'session-2', directory: home, agent: 'claude', initialPrompt: 'grandchild' };
            strict = true;
            await unlink(endpointStorePath);
            await expect(runtime.spawn(grandchildInput)).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_NOT_SYNCED' });
            expect(starts).toBe(2); expect(operations.size).toBe(1);
            await writeFile(endpointStorePath, JSON.stringify({ version: 1, endpoints: { endpoint: { ...sync().endpoint, companyId: 'company', userId: 'user' } } }), { mode: 0o600 });
            expect(await runtime.spawn(grandchildInput)).toMatchObject({ ok: true, sessionId: 'session-3', endpointId: 'endpoint' });
            expect(await runtime.spawn(grandchildInput)).toMatchObject({ ok: true, sessionId: 'session-3' });
            expect(starts).toBe(3); expect(sessions).toBe(3);
            expect(await runtime.checkResume({ bindingId: 'binding-1', sessionId: 'session-2', endpointId: 'endpoint', targetId: 'target-a', generation: 3 })).toEqual({ ok: true });
            expect(syncs).toEqual({ reentrant: 1, response: 1 });
            expect(probes).toEqual(['/a/v1/models', '/b/v1/models']);
            expect(rejected).toEqual([]);
            records['session-1'].agentEnvironment!.SAYCODE_AGENT_MAX_SPAWN = '12';
            await expect(runtime.spawn(childInput)).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_OPERATION_CONFLICT' });
            expect(starts).toBe(3);
            badReceipt = true;
            const receiptInput = { ...childInput, operationId: 'bad-receipt', spawnId: 'bad-receipt' };
            expect(await runtime.spawn(receiptInput)).toMatchObject({ ok: false, error: 'spawn_pending' });
            expect(operations.get('bad-receipt')?.state).toBe('launching');
            expect(await runtime.spawn(receiptInput)).toMatchObject({ ok: false, error: 'spawn_pending' });
            expect(starts).toBe(4);
            delete records['session-2'].metadata.orgLlmEndpoint;
            delete records['session-2'].agentEnvironment![ORG_ENDPOINT_BINDING_ENV];
            await expect(runtime.context({ sourceSessionId: 'session-2', checkServer: true })).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_PARENT_BOUND' });
            expect(starts).toBe(4);
        } finally {
            configuration.serverUrl = originalUrl;
            credentialRuntime?.stopPersonalScheduler();
            await new Promise<void>(resolve => http.close(() => resolve()));
            await rm(home, { recursive: true, force: true });
        }
    });
});


describe('subagent current registration', () => {
    it('uses the authenticated server machine instead of the unwritten local confirmation flag, and rejects identity changes', async () => {
        const credentials = { token: 'registration-test', encryption: { type: 'dataKey' as const, publicKey: new Uint8Array(32), machineKey: new Uint8Array(32) } };
        let status = 200, returnedId = 'machine', reads = 0, changeDuringLookup = false, requests = 0;
        const http = createServer((req, res) => {
            requests++; expect(req.method).toBe('GET'); expect(req.url).toBe('/v1/machines/machine');
            expect(req.headers.authorization).toBe('Bearer registration-test');
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ machine: { id: returnedId, accountId: 'account' } }));
        });
        await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
        const origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
        const read = async () => { reads++; return { credentials: changeDuringLookup && reads > 1 ? { ...credentials, token: 'replacement' } : credentials,
            settings: { machineId: 'machine' } }; };
        const invoke = () => { reads = 0; return readOrgSubagentRegistration({ machineId: 'machine', credentials, happyOrigin: origin, read }); };
        try {
            await expect(invoke()).resolves.toMatchObject({ machineId: 'machine', happyAccountId: 'account', credentials });
            expect(reads).toBe(2); expect(requests).toBe(1);
            returnedId = 'another-machine';
            await expect(invoke()).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_MACHINE_FORBIDDEN' });
            returnedId = 'machine'; changeDuringLookup = true;
            await expect(invoke()).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_MACHINE_FORBIDDEN' });
            changeDuringLookup = false; status = 404;
            await expect(invoke()).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_MACHINE_FORBIDDEN' });
            status = 503;
            await expect(invoke()).rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_VERIFICATION_UNAVAILABLE' });
            const before = requests;
            await expect(readOrgSubagentRegistration({ machineId: 'other', credentials, happyOrigin: origin, read }))
                .rejects.toMatchObject({ code: 'ORG_LLM_ENDPOINT_MACHINE_FORBIDDEN' });
            expect(requests).toBe(before);
        } finally { await new Promise<void>(resolve => http.close(() => resolve())); }
    });
});
