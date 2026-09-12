// Executed by the opt-in integration test under the CLI tsx runtime.
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const c = JSON.parse(await readFile(process.argv[2], 'utf8'));
const load = (path) => import(pathToFileURL(path).href);
const { PGlite } = createRequire(c.web + '/package.json')('@electric-sql/pglite');
const { createScriptAutomationKeyStore } = await load(c.web + '/server/scriptAutomationKeyDb.ts');
const { createScriptAutomationService } = await load(c.web + '/server/scriptAutomationService.ts');
const { createScriptManagementService } = await load(c.web + '/server/scriptManagementService.ts');
const { authorizeScriptExecution } = await load(c.web + '/server/scriptExecutionAuthorization.ts');
const { handleScriptPublicRequest } = await load(c.web + '/server/scriptAutomationRoutes.ts');
const { issueMcpCallerGrant, verifyMcpCallerGrant } = await load(c.web + '/server/mcpCallerGrantToken.ts');
const { createScriptAutomationTools } = await load(c.cli + '/src/claude/utils/scriptAutomationTools.ts');
const { createScriptAutomationWorker } = await load(c.cli + '/src/daemon/automations/scriptAutomationWorker.ts');
const { prepareManagedScriptRuntime, recoverManagedScriptContainers } = await load(c.cli + '/src/daemon/automations/managedScriptRuntime.ts');
const { runManagedScript } = await load(c.cli + '/src/daemon/automations/managedScriptRunner.ts');
const nacl = createRequire(c.cli + '/package.json')('tweetnacl');
const pair = nacl.box.keyPair.fromSecretKey(new Uint8Array(c.secretKey));
const db = new PGlite();
await db.exec(await readFile(c.web + '/prisma/migrations/20260909011500_script_automation_api_keys/migration.sql', 'utf8'));
const keys = createScriptAutomationKeyStore({ transaction: (action) => db.transaction((tx) => action({ query: async (sql, values = []) => (await tx.query(sql, values)).rows })) });
let allowed = true;
const bindings = new Map();
const assertAccess = async (userId, projectId) => { if (!allowed || userId !== 'studio-user' || projectId !== 'p1') throw Error('PROJECT_WRITE_DENIED'); };
const forward = async ({ method, path, body, idempotencyKey }) => {
  const response = await fetch(c.url + path, { method, headers: { Authorization: 'Bearer fixture-machine', 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
    body: method === 'GET' ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.json() };
};
const request = async (method, path, body) => { const response = await forward({ method, path, body }); if (response.status >= 400) throw Error(response.body.error); return response.body; };
const findBinding = async (id) => bindings.get(id) ?? null;
const resolveToken = async () => 'fixture-machine';
const service = createScriptAutomationService({ keys, forward, assertAccess, findBinding, resolveToken, secret: () => c.serviceSecret, now: Date.now });
const management = createScriptManagementService({ forward, resolveToken, secret: () => c.serviceSecret, readAccess: assertAccess, writeAccess: assertAccess,
  isOwner: async () => true, bootstrap: async () => {}, findBinding, listBindings: async () => [...bindings.values()], recordEditor: async () => {},
  reserve: async ({ automationId, projectId, userId }) => {
    if (!bindings.has(automationId)) bindings.set(automationId, { automationId, projectId, createdByUserId: userId, updatedByUserId: userId,
      runAsUserId: userId, boundByUserId: userId, status: 'BOUND', connectorPolicy: 'none', requiredConnectors: [] });
    return bindings.get(automationId);
  } });
process.env.APLUS_CONNECTOR_CAPABILITY_SECRET = c.serviceSecret;
const grant = issueMcpCallerGrant({ userId: 'studio-user', projectId: 'p1', machineId: 'machine' }).token;
const server = createServer((req, res) => {
  void handleScriptPublicRequest(req, res, () => { res.writeHead(404); res.end(); }, {
    enabled: () => true, submit: service.submit, status: service.status, secrets: async () => ({}),
    authorize: (input) => authorizeScriptExecution(input, { verifyContext: (input) => request('POST', `/v1/machines/machine/script-runs/${input.runId}/context`, { token: input.claimToken }),
      findBinding, assertAccess, secret: () => c.serviceSecret, now: Date.now }),
    agent: { execute: management.execute, verify: async (input) => {
      const caller = verifyMcpCallerGrant(input.callerGrant, { projectId: input.projectId, machineId: input.machineId });
      if (!caller || input.bearer !== 'fixture-machine') throw Error('SCRIPT_AGENT_IDENTITY_DENIED');
      await assertAccess(caller.userId, input.projectId); return { userId: caller.userId };
    } },
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const studio = `http://127.0.0.1:${server.address().port}`;
const temporaryRoot = c.directory + '/work';
let worker;
try {
  const tools = createScriptAutomationTools({ projectId: 'p1', directory: c.directory, viewerKeyPair: pair,
    request: async (request) => {
      const response = await fetch(studio + '/api/automation/script-management', { method: 'POST', headers: {
        Authorization: 'Bearer fixture-machine', 'Content-Type': 'application/json', 'X-Aplus-Caller-Grant': grant,
      }, body: JSON.stringify({ projectId: 'p1', machineId: 'machine', request }) });
      const value = await response.json(); if (!response.ok) throw Error(value.error); return value;
    } });
  await writeFile(c.directory + '/collect.mjs', 'let s="";for await(const c of process.stdin)s+=c;console.log(JSON.stringify({count:JSON.parse(s).count,uid:process.getuid()}));');
  const definition = { operation: 'upsert', registrationKey: 'api-collector', expectedRevision: 0, sourcePath: 'collect.mjs', name: 'API collector', schedule: null, externalEnabled: true };
  const registered = await tools.execute(definition);
  assert.equal((await tools.execute(definition)).id, registered.id);
  assert.equal(bindings.size, 1);
  await prepareManagedScriptRuntime({ ownerId: c.ownerId, directory: temporaryRoot, image: c.image });
  worker = createScriptAutomationWorker({ machineId: 'machine', accountId: 'owner', machineSecretKey: pair.secretKey, image: c.image, directory: c.directory + '/outbox',
    request, log: console.error, recoverContainers: () => recoverManagedScriptContainers({ ownerId: c.ownerId, directory: temporaryRoot }),
    execute: (input) => runManagedScript({ ...input, ownerId: c.ownerId, temporaryRoot }),
    authorizeStart: async (_record, runId, claimToken) => {
      const response = await fetch(studio + '/api/automation/script-execution', { method: 'POST', headers: { Authorization: 'Bearer fixture-machine', 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId: 'machine', runId, claimToken }) });
      const value = await response.json(); if (!response.ok) throw Error(value.error); return value.executionProof;
    } });
  await worker.tick(); // Verify the encrypted revision before accepting external input.
  const scope = { projectId: 'p1', automationId: registered.id };
  const issued = await service.issueKey({ ...scope, userId: 'studio-user', name: 'Fixture', expiresAt: Date.now() + 600000 });
  assert(!JSON.stringify((await db.query('SELECT * FROM "ScriptAutomationApiKey"')).rows).includes(issued.token));
  const submit = async (key) => {
    const response = await fetch(studio + `/api/v1/projects/p1/automations/${registered.id}/runs`, { method: 'POST', headers: {
      Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key,
    }, body: JSON.stringify({ input: { count: 3 } }) });
    assert.equal(response.status, 202); return response.json();
  };
  const accepted = await submit('one-request');
  assert.equal((await submit('one-request')).runId, accepted.runId);
  await worker.tick();
  const status = await fetch(studio + accepted.statusUrl, { headers: { Authorization: `Bearer ${issued.token}` } });
  assert.equal(status.status, 200);
  const result = await status.json(); assert.equal(result.status, 'COMPLETED'); assert.equal(result.exitCode, 0);
  assert(!('logCiphertext' in result));
  const history = await tools.execute({ operation: 'list_runs', automationId: registered.id, runId: accepted.runId });
  assert.deepEqual(JSON.parse(history[0].log.log), { count: 3, uid: 65534 });
  const second = await submit('permission-revoked');
  allowed = false;
  await worker.tick();
  allowed = true;
  const denied = await service.status({ ...scope, token: issued.token, runId: second.runId });
  assert.equal(denied.status, 'FAILED'); assert.equal(denied.failureCode, 'PROJECT_WRITE_DENIED');
  await service.revokeKey({ ...scope, userId: 'studio-user', keyId: issued.key.id });
  await assert.rejects(() => service.status({ ...scope, token: issued.token, runId: accepted.runId }), /KEY_INACTIVE/);
  console.log(JSON.stringify({ adminId: registered.id, runId: accepted.runId, completed: result.status, revokedBeforeStart: denied.status }));
} finally {
  await worker?.stop();
  await recoverManagedScriptContainers({ ownerId: c.ownerId, directory: temporaryRoot });
  await new Promise((resolve) => server.close(resolve));
  await db.close();
}
