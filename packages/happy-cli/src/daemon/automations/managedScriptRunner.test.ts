import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManagedScript } from './managedScriptRunner';
import type { ScriptAutomationPayload } from '@slopus/happy-wire';

const source = 'console.log("ok")';
const action: ScriptAutomationPayload['action'] = {
  kind: 'script', runtime: 'node', artifactId: 'a1', digest: createHash('sha256').update(source).digest('hex'),
  entrypoint: 'collect.mjs', args: [], secretRefs: {}, allowedOrigins: [], timeoutSeconds: 2,
};
describe('managed script preparation', () => {
  it('rejects a modified bundle before attempting Docker execution', async () => {
    await expect(runManagedScript({ runId: 'run-1', source: source + '//changed', action, input: {}, secrets: {},
      image: 'sha256:' + 'a'.repeat(64) })).rejects.toThrow('ARTIFACT_DIGEST_MISMATCH');
  });
  it('rejects mutable images, path escapes, unexpected secrets and oversized input', async () => {
    const base = { runId: 'run-1', source, action, input: {}, secrets: {}, image: 'sha256:' + 'a'.repeat(64) };
    await expect(runManagedScript({ ...base, image: 'node:latest' })).rejects.toThrow('IMMUTABLE_IMAGE_REQUIRED');
    await expect(runManagedScript({ ...base, action: { ...action, entrypoint: '../escape.mjs' } })).rejects.toThrow();
    await expect(runManagedScript({ ...base, secrets: { NODE_OPTIONS: 'override' } })).rejects.toThrow('SECRET_BINDING_MISMATCH');
    await expect(runManagedScript({ ...base, input: { value: 'x'.repeat(65536) } })).rejects.toThrow('INPUT_TOO_LARGE');
  });
});

const docker = promisify(execFile);
describe.runIf(process.env.HAPPY_SCRIPT_DOCKER_TESTS === '1')('managed script Docker integration', () => {
  const image = async () => (await docker('docker', ['image', 'inspect', 'node:24-alpine', '--format', '{{.Id}}'])).stdout.trim();
  const makeAction = (source: string): ScriptAutomationPayload['action'] => ({ ...action, digest: createHash('sha256').update(source).digest('hex'), timeoutSeconds: 10 });

  it('passes JSON stdin, masks secrets and removes its container', async () => {
    const source = 'import fs from "node:fs";let text="";for await(const c of process.stdin)text+=c;console.log(JSON.stringify({input:JSON.parse(text),uid:process.getuid(),host:fs.existsSync("/root/.happy"),secret:process.env.PB_TOKEN}));';
    const result = await runManagedScript({ runId: 'script-integration-input', source,
      action: { ...makeAction(source), secretRefs: { PB_TOKEN: 'test-ref' } }, input: { value: 7 }, secrets: { PB_TOKEN: 'test-secret-marker' }, image: await image() });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.log)).toEqual({ input: { value: 7 }, uid: 65534, host: false, secret: '[REDACTED]' });
    expect((await docker('docker', ['ps', '-aq', '--filter', 'label=happy.script.runId=script-integration-input'])).stdout.trim()).toBe('');
  }, 30000);

  it('kills timed out executions and bounds their output', async () => {
    const source = 'process.stdout.write("x".repeat(2*1024*1024));setInterval(()=>{},1000);';
    const result = await runManagedScript({ runId: 'script-integration-timeout', source,
      action: { ...makeAction(source), timeoutSeconds: 1 }, input: {}, secrets: {}, image: await image() });
    expect(result.failureCode).toBe('SCRIPT_TIMEOUT');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.log)).toBe(1024 * 1024);
    expect((await docker('docker', ['ps', '-aq', '--filter', 'label=happy.script.runId=script-integration-timeout'])).stdout.trim()).toBe('');
  }, 30000);

  it('does not start when the final claim check rejects, and cancels a running container', async () => {
    const source = 'setInterval(()=>{},1000);';
    const base = { runId: 'script-integration-cancel', source, action: makeAction(source), input: {}, secrets: {}, image: await image() };
    await expect(runManagedScript({ ...base, beforeStart: async () => { throw new Error('CLAIM_REVOKED'); } })).rejects.toThrow('CLAIM_REVOKED');
    const controller = new AbortController();
    const result = await runManagedScript({ ...base, signal: controller.signal, beforeStart: async () => { setTimeout(() => controller.abort(), 200); } });
    expect(result.failureCode).toBe('SCRIPT_CANCELLED');
    expect((await docker('docker', ['ps', '-aq', '--filter', 'label=happy.script.runId=script-integration-cancel'])).stdout.trim()).toBe('');
  }, 30000);

  it('reaches only a bound private DB through the proxy and blocks unbound destinations', async () => {
    const imageId = await image();
    const db = `script-test-db-${Date.now()}`;
    await docker('docker', ['run', '-d', '--name', db, '--network', 'bridge', imageId, 'node', '-e',
      'require("http").createServer((q,s)=>s.end(JSON.stringify({ok:true}))).listen(8090,"0.0.0.0")']);
    try {
      const ip = (await docker('docker', ['inspect', db, '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'])).stdout.trim();
      const origin = `http://${ip}:8090`;
      const source = `const response=await fetch(${JSON.stringify(origin)});console.log(await response.text());try { await fetch("http://169.254.169.254",{signal:AbortSignal.timeout(2000)});process.exit(9) }catch{console.log("blocked")}`;
      const result = await runManagedScript({ runId: 'script-integration-db', source,
        action: { ...makeAction(source), allowedOrigins: [origin] }, approvedPrivateOrigins: [origin], input: {}, secrets: {}, image: imageId });
      expect(result.exitCode).toBe(0);
      expect(result.log).toContain('{"ok":true}');
      expect(result.log).toContain('blocked');
    } finally { await docker('docker', ['rm', '-f', db]); }
  }, 30000);
});
