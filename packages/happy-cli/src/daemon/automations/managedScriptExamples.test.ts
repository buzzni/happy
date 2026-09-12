import { afterAll, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { runManagedScript } from './managedScriptRunner';
const exec = promisify(execFile);
const examples = resolve('../../../../specs/project-script-automations/examples');
const image = 'sha256:b3ba23292f4c342e7969cc88e1abf816e6d8d6b169472a40848a154c0bc29ace';
const container = `script-pb-test-${randomBytes(6).toString('hex')}`;
let created = false;
afterAll(async () => { if (created) await exec('docker', ['rm', '-f', container]); });
it.runIf(process.env.HAPPY_SCRIPT_DOCKER_TESTS === '1')('collects through scoped PocketBase auth, upserts duplicates, reports partial failure and serves a secret-free frontend', async () => {
  const password = randomBytes(24).toString('hex');
  await exec('docker', ['create', '--name', container, '--entrypoint', 'pocketbase', '-p', '127.0.0.1::8090',
    '-e', 'PB_COLLECTOR_EMAIL=collector@example.test', '-e', `PB_COLLECTOR_PASSWORD=${password}`, '-e', 'PB_ENVIRONMENT=development',
    process.env.HAPPY_SCRIPT_PB_IMAGE ?? 'namsangboy/aplus_dev_node24_gui:electron-gui-83d3552de',
    'serve', '--http=0.0.0.0:8090', '--dir=/tmp/pb_data', '--migrationsDir=/tmp/pb_migrations', '--publicDir=/tmp/pb_public']);
  created = true;
  await exec('docker', ['cp', resolve(examples, 'pb_migrations'), `${container}:/tmp/pb_migrations`]);
  await exec('docker', ['cp', resolve(examples, 'pb_public'), `${container}:/tmp/pb_public`]);
  await exec('docker', ['start', container]);
  const [{ stdout: port }, { stdout: ip }] = await Promise.all([exec('docker', ['port', container, '8090/tcp']), exec('docker', ['inspect', '-f', '{{(index .NetworkSettings.Networks "bridge").IPAddress}}', container])]);
  const host = `http://${port.trim()}`;
  const origin = `http://${ip.trim()}:8090`;
  let healthy = false;
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${host}/api/health`)).ok) { healthy = true; break; } } catch {} await new Promise((resolve) => setTimeout(resolve, 100)); }
  expect(healthy).toBe(true);
  const source = await readFile(resolve(examples, 'collect-pocketbase.mjs'), 'utf8');
  const execute = (input: Record<string, unknown>, credentials = password) => runManagedScript({ runId: randomBytes(8).toString('hex'), image, source, input,
    action: { kind: 'script', runtime: 'node', artifactId: 'example', digest: createHash('sha256').update(source).digest('hex'), entrypoint: 'collect.mjs', args: [], timeoutSeconds: 30,
      secretRefs: { PB_ORIGIN: 'env:test:PB_ORIGIN', PB_COLLECTOR_EMAIL: 'env:test:PB_COLLECTOR_EMAIL', PB_COLLECTOR_PASSWORD: 'env:test:PB_COLLECTOR_PASSWORD', PB_ENVIRONMENT: 'env:test:PB_ENVIRONMENT', COLLECT_SOURCE_URL: 'env:test:COLLECT_SOURCE_URL', COLLECT_SOURCE_NAME: 'env:test:COLLECT_SOURCE_NAME' }, allowedOrigins: [origin] },
    // Only this isolated test target gets a private-origin grant. Production never trusts request-supplied grants.
    approvedPrivateOrigins: [origin], secrets: { PB_ORIGIN: origin, PB_COLLECTOR_EMAIL: 'collector@example.test', PB_COLLECTOR_PASSWORD: credentials, PB_ENVIRONMENT: 'development', COLLECT_SOURCE_URL: `${origin}/source.json`, COLLECT_SOURCE_NAME: 'fixture' } });
  const input = { environment: 'development', source: 'fixture', items: [{ key: 'one', value: 3, published: true }] };
  expect((await execute({})).exitCode).toBe(0);
  const first = await execute(input);
  expect(first).toMatchObject({ exitCode: 0, failureCode: null });
  const again = await execute({ ...input, items: [{ key: 'one', value: 7, published: true }] });
  expect(again.exitCode).toBe(0);
  const rows = await (await fetch(`${host}/api/collections/collected_metrics/records`)).json() as { items: { value: number }[]; totalItems: number };
  expect(rows.totalItems).toBe(1); expect(rows.items[0].value).toBe(7);
  const partial = await execute({ ...input, items: [{ key: 'two', value: 2, published: true }, { key: '', value: 1 }] });
  expect(partial.exitCode).not.toBe(0); expect(partial.log).toContain('"succeeded":1'); expect(partial.log).toContain('"failed":1');
  expect((await execute({ ...input, environment: 'production' })).exitCode).not.toBe(0);
  expect((await execute(input, 'incorrect-password')).exitCode).not.toBe(0);
  expect((await fetch(`${host}/api/collections/collected_metrics/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ externalKey: 'unauthorized', value: 9 }) })).ok).toBe(false);
  const html = await (await fetch(host)).text();
  expect(html).toContain('/api/collections/collected_metrics/records'); expect(html).not.toContain(password); expect(html).not.toContain('PB_COLLECTOR_PASSWORD');
  expect(first.log + again.log + partial.log).not.toContain(password);
}, 120_000);
