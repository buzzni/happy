import { createHash, randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scriptAutomationPayloadSchema, type ScriptAutomationPayload } from '@slopus/happy-wire';
import { projectPath } from '@/projectPath';

const exec = promisify(execFile);
const LOG_LIMIT = 1024 * 1024;
const limits = ['--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
  '--user', '65534:65534', '--memory', '512m', '--cpus', '1', '--pids-limit', '64',
  '--tmpfs', '/tmp:rw,noexec,nosuid,size=16m', '--init'];
const docker = (args: string[]) => exec('docker', args, { timeout: 30000, maxBuffer: LOG_LIMIT });

export type ManagedScriptInput = {
  runId: string; source: string; action: ScriptAutomationPayload['action']; input: Record<string, unknown>;
  secrets: Record<string, string>; image: string; signal?: AbortSignal;
  /** Atomically revalidate the claim after preparation and before script execution. */
  beforeStart?: () => Promise<void>;
  ownerId?: string;
  temporaryRoot?: string;
  /** Supplied only by the verified project DB binding, never by the script payload. */
  approvedPrivateOrigins?: string[];
};
export type ManagedScriptResult = {
  exitCode: number | null; log: string; truncated: boolean; failureCode: string | null;
};

export async function runManagedScript(input: ManagedScriptInput): Promise<ManagedScriptResult> {
  const action = scriptAutomationPayloadSchema.shape.action.parse(input.action);
  if (createHash('sha256').update(input.source).digest('hex') !== action.digest) throw new Error('ARTIFACT_DIGEST_MISMATCH');
  if (!/^(?:sha256:|[\w./:-]+@sha256:)[a-f0-9]{64}$/.test(input.image)) throw new Error('IMMUTABLE_IMAGE_REQUIRED');
  const names = Object.keys(action.secretRefs).sort();
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(input.secrets).sort())) throw new Error('SECRET_BINDING_MISMATCH');
  const stdin = JSON.stringify(input.input);
  if (Buffer.byteLength(stdin) > 65536) throw new Error('INPUT_TOO_LARGE');
  input.signal?.throwIfAborted();
  const id = `happy-script-${randomBytes(10).toString('hex')}`;
  const proxy = `${id}-proxy`;
  if (input.ownerId && !/^[a-f0-9]{64}$/.test(input.ownerId)) throw new Error('SCRIPT_OWNER_INVALID');
  const ownerLabel = input.ownerId ? ['--label', `happy.script.owner=${input.ownerId}`] : [];
  const directory = await mkdtemp(join(input.temporaryRoot ?? tmpdir(), 'happy-script-'));
  const bundle = join(directory, 'bundle.mjs');
  const secretFile = join(directory, 'env.json');
  const containers: string[] = [];
  let networkCreated = false;
  try {
    await writeFile(bundle, input.source, { mode: 0o444 });
    await writeFile(secretFile, JSON.stringify(input.secrets), { mode: 0o444 });
    let network = 'none';
    if (action.allowedOrigins.length) {
      await docker(['network', 'create', ...ownerLabel, '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', id]);
      networkCreated = true;
      network = id;
      await docker(['create', '--name', proxy, '--label', `happy.script.runId=${input.runId}`, ...ownerLabel, ...limits,
        '--network', 'bridge', '--env', `SCRIPT_ALLOWED_ORIGINS=${JSON.stringify(action.allowedOrigins)}`,
        '--env', `SCRIPT_PRIVATE_ORIGINS=${JSON.stringify(input.approvedPrivateOrigins ?? [])}`,
        '--mount', `type=bind,src=${join(projectPath(), 'scripts/script-egress-proxy.mjs')},dst=/proxy.mjs,readonly`,
        input.image, 'timeout', '-s', 'KILL', String(action.timeoutSeconds + 60), 'node', '/proxy.mjs']);
      containers.push(proxy);
      await docker(['network', 'connect', '--alias', 'egress', id, proxy]);
      await docker(['start', proxy]);
      // A TCP probe checks listener readiness without opening an allowlisted URL.
      await docker(['exec', proxy, 'node', '-e',
        'let n=0;function probe(){const s=require("net").connect(8080,"127.0.0.1");s.on("connect",()=>{s.end();process.exit(0)});s.on("error",()=>{if(++n===20)process.exit(1);setTimeout(probe,100)})}probe()']);
    }
    input.signal?.throwIfAborted();
    const bootstrap = 'Object.assign(process.env,JSON.parse(require("fs").readFileSync("/script-env.json","utf8")));import(require("url").pathToFileURL(process.argv[1]).href)';
    await docker(['create', '--name', id, '--label', `happy.script.runId=${input.runId}`, ...ownerLabel, ...limits,
      '--network', network, '--interactive', '--workdir', '/job',
      '--mount', `type=bind,src=${bundle},dst=/job/${action.entrypoint},readonly`,
      '--mount', `type=bind,src=${secretFile},dst=/script-env.json,readonly`,
      ...(network === 'none' ? [] : ['--env', 'HTTP_PROXY=http://egress:8080', '--env', 'HTTPS_PROXY=http://egress:8080', '--env', 'NODE_USE_ENV_PROXY=1']),
      input.image, 'timeout', '-s', 'KILL', String(action.timeoutSeconds), 'node', '-e', bootstrap, `/job/${action.entrypoint}`, ...action.args]);
    containers.push(id);
    await input.beforeStart?.();
    input.signal?.throwIfAborted();
    const result = await new Promise<ManagedScriptResult>((resolve, reject) => {
      const process = spawn('docker', ['start', '--attach', '--interactive', id], { stdio: ['pipe', 'pipe', 'pipe'] });
      const secrets = Object.values(input.secrets).filter(Boolean).sort((a, b) => b.length - a.length);
      const captureLimit = LOG_LIMIT + Math.max(0, ...secrets.map((value) => Buffer.byteLength(value)));
      const chunks: Buffer[] = [];
      let retained = 0;
      let total = 0;
      let failureCode: string | null = null;
      let stopping: Promise<unknown> | null = null;
      const capture = (chunk: Buffer) => {
        total += chunk.length;
        if (retained < captureLimit) {
          const kept = chunk.subarray(0, captureLimit - retained);
          chunks.push(kept); retained += kept.length;
        }
      };
      const stop = (code: string) => {
        if (stopping) return;
        failureCode = code;
        stopping = docker(['kill', id]).catch(() => {
          failureCode = 'SCRIPT_KILL_FAILED';
          process.kill('SIGKILL');
          // End the attach operation so finally can force-remove the container.
          // If removal fails, cleanup propagates that failure to the caller.
        });
      };
      const timer = setTimeout(() => stop('SCRIPT_TIMEOUT'), action.timeoutSeconds * 1000);
      const abort = () => stop('SCRIPT_CANCELLED');
      input.signal?.addEventListener('abort', abort, { once: true });
      if (input.signal?.aborted) abort();
      process.stdout.on('data', capture);
      process.stderr.on('data', capture);
      process.stdin.on('error', () => { /* Early script exit is reported via exit code. */ });
      process.stdin.end(stdin);
      const done = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); };
      process.on('error', (error) => { done(); reject(error); });
      process.on('close', async (exitCode) => {
        done();
        if (stopping) await stopping;
        let log = Buffer.concat(chunks).toString('utf8');
        for (const secret of secrets) log = log.split(secret).join('[REDACTED]');
        resolve({ exitCode, log: Buffer.from(log).subarray(0, LOG_LIMIT).toString('utf8'), truncated: total > LOG_LIMIT, failureCode });
      });
    });
    return result;
  } finally {
    // Do not discard the source/secret files before every container is removed.
    // Cleanup failures propagate; a daemon recovery pass can then retry by label.
    const cleanup = await Promise.allSettled(containers.map((name) => docker(['rm', '--force', name])));
    if (cleanup.some((result) => result.status === 'rejected')) throw new Error('SCRIPT_CONTAINER_CLEANUP_FAILED');
    if (networkCreated) await docker(['network', 'rm', id]);
    await rm(directory, { recursive: true, force: true });
  }
}
