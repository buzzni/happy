import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile, open } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { getProjectPath } from '@/claude/utils/path';
import { projectPath } from '@/projectPath';
import { reservationContainerLabels, reservationDocker, type ReservationContainerScope } from './reservationNativeContainer';
import type { ReservationTurnDescriptor } from './reservationConversationTurn';

const exec = promisify(execFile), hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
const gitEnv = () => ({ PATH: process.env.PATH, LANG: 'C', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = async (cwd: string, args: string[]) => (await exec('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', cwd, ...args], { env: gitEnv(), timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
async function regular(file: string): Promise<Buffer> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024 || await realpath(file) !== file) throw new Error('RESERVATION_NATIVE_STATE_INVALID');
  return readFile(file);
}
export async function findReservationNativeTranscript(agent: 'claude' | 'codex', nativeId: string, baseDirectory: string, environment: Record<string, string | undefined>, home = homedir()): Promise<string> {
  if (agent === 'claude') return realpath(join(getProjectPath(baseDirectory, environment.CLAUDE_CONFIG_DIR ?? join(home, '.claude')), `${nativeId}.jsonl`));
  const root = await realpath(join(environment.CODEX_HOME ?? join(home, '.codex'), 'sessions'));
  let found: string | null = null, visited = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 100000) throw new Error('RESERVATION_NATIVE_STATE_LIMIT');
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(`-${nativeId}.jsonl`)) { if (found) throw new Error('RESERVATION_NATIVE_STATE_AMBIGUOUS'); found = path; }
    }
  };
  await visit(root, 0); if (!found) throw new Error('RESERVATION_NATIVE_STATE_MISSING'); return realpath(found);
}

export async function reservationGitCommonDirectory(directory: string): Promise<string> { return realpath(resolve(directory, await git(directory, ['rev-parse', '--git-common-dir']))); }

/** Materializes only the selected native transcript and a private Git metadata view. No account credential files are copied. */
export async function prepareReservationNativeWorkspace(input: { root: string; descriptor: ReservationTurnDescriptor; nativeId: string; sourceTranscript: string; broker: { url: string; token: string }; model: string; projectEnvironment?: Record<string, string>; protectedDirectories?: string[]; commandsOnly?: boolean }) {
  const { descriptor } = input;
  const execution = await realpath(descriptor.executionDirectory), base = await realpath(descriptor.baseDirectory);
  if (execution !== descriptor.executionDirectory || base !== descriptor.baseDirectory || [execution, base].some(path => (input.protectedDirectories ?? []).some(protectedPath => !relative(path, resolve(protectedPath)).startsWith('..')) || path === '/' || !relative(path, homedir()).startsWith('..') || !relative(path, input.root).startsWith('..'))) throw new Error('RESERVATION_DIRECTORY_INVALID');
  const source = await regular(input.sourceTranscript), sourceHash = hash(source);
  // A filename alone cannot establish the saved native lineage.
  const first = source.toString('utf8').split('\n').filter(Boolean).slice(0, 100).map(line => { try { return JSON.parse(line); } catch { return null; } });
  const matches = descriptor.agent === 'claude' ? first.some(value => value?.sessionId === input.nativeId || value?.session_id === input.nativeId)
    : first.some(value => value?.type === 'session_meta' && value?.payload?.id === input.nativeId);
  if (!matches) throw new Error('RESERVATION_NATIVE_LINEAGE_MISMATCH');
  await mkdir(input.root, { recursive: true, mode: 0o700 });
  const directory = await realpath(await mkdtemp(join(input.root, 'turn-')));
  try {
  const home = join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const mounts = [{ source: execution, target: execution, writable: descriptor.writeMode === 'worktree' }, { source: home, target: '/home/reservation', writable: true }];
  const codexRelative = input.sourceTranscript.includes('/sessions/') ? input.sourceTranscript.slice(input.sourceTranscript.lastIndexOf('/sessions/') + '/sessions/'.length) : basename(input.sourceTranscript);
  if (codexRelative.split('/').some(part => part === '..' || !part)) throw new Error('RESERVATION_NATIVE_STATE_INVALID');
  const state = descriptor.agent === 'claude' ? join(getProjectPath(execution, join(home, '.claude')), `${input.nativeId}.jsonl`) : join(home, '.codex', 'sessions', codexRelative);
  if (!input.commandsOnly) {
  await mkdir(dirname(state), { recursive: true, mode: 0o700 }); await writeFile(state, source, { mode: 0o600 });
  }
  if (descriptor.headSha) {
  const common = await reservationGitCommonDirectory(execution), actualGitdir = await realpath(await git(execution, ['rev-parse', '--absolute-git-dir']));
  const gitdirRelative = relative(common, actualGitdir);
  if (gitdirRelative === '..' || gitdirRelative.startsWith(`..${sep}`)) throw new Error('RESERVATION_GIT_SCOPE_INVALID');
  if (descriptor.headSha && await git(execution, ['rev-parse', '--verify', 'HEAD']) !== descriptor.headSha) throw new Error('RESERVATION_HEAD_CHANGED');
  const privateCommon = join(directory, 'git'), privateGitdir = join(privateCommon, gitdirRelative);
  await mkdir(join(privateCommon, 'refs'), { recursive: true, mode: 0o700 });
  await mkdir(join(privateCommon, 'objects', 'info'), { recursive: true, mode: 0o700 }); await mkdir(privateGitdir, { recursive: true, mode: 0o700 });
  await writeFile(join(privateCommon, 'config'), '[core]\nrepositoryformatversion = 0\nbare = false\nhooksPath = /dev/null\nfsmonitor = false\n', { mode: 0o600 });
  await writeFile(join(privateCommon, 'objects', 'info', 'alternates'), '/opt/reservation-objects\n', { mode: 0o600 });
  for (const name of ['HEAD', 'index', 'commondir', 'gitdir']) {
    try { await writeFile(join(privateGitdir, name), await regular(join(actualGitdir, name)), { mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || name === 'HEAD') throw error; }
  }
  const originalHead = (await readFile(join(privateGitdir, 'HEAD'), 'utf8')).trim();
  if (originalHead.startsWith('ref: ')) {
    const reference = originalHead.slice(5);
    if (!reference.startsWith('refs/heads/') || reference.split('/').some(part => !part || part === '..')) throw new Error('RESERVATION_GIT_SCOPE_INVALID');
    const targetRef = join(privateCommon, reference); await mkdir(dirname(targetRef), { recursive: true, mode: 0o700 });
    await writeFile(targetRef, await git(execution, ['rev-parse', '--verify', 'HEAD']) + '\n', { mode: 0o600 });
  }
  if (actualGitdir === common) {
    const head = await git(execution, ['rev-parse', '--verify', 'HEAD']);
    await writeFile(join(privateCommon, 'HEAD'), `${head}\n`, { mode: 0o600 });
  }
  mounts.push({ source: privateCommon, target: common, writable: true }, { source: await realpath(join(common, 'objects')), target: '/opt/reservation-objects', writable: false });
  } else if (await lstat(join(execution, '.git')).catch(error => { if (error.code !== 'ENOENT') throw error; return null; })) throw new Error('RESERVATION_GIT_SCOPE_INVALID');
  const mcp = descriptor.agent === 'claude' ? join(home, 'mcp.json') : join(home, 'mcp-bridge.mjs');
  if (!input.commandsOnly) {
  if (descriptor.agent === 'claude') await writeFile(mcp, JSON.stringify({ mcpServers: { reservation: { type: 'http', url: input.broker.url + '/mcp', headers: { Authorization: `Bearer ${input.broker.token}` } } } }), { mode: 0o600 });
  else {
    const bridge = `import readline from 'node:readline';
for await(const line of readline.createInterface({input:process.stdin})){if(!line.trim())continue;const value=JSON.parse(line);
try{const r=await fetch(process.env.SAYCODE_RESERVATION_BROKER+'/mcp',{method:'POST',headers:{Authorization:'Bearer '+process.env.SAYCODE_RESERVATION_CAPABILITY,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify(value)});
if(value.id===undefined)continue;if(!r.ok)throw Error('broker refused');const text=await r.text();
if(r.headers.get('content-type')?.includes('text/event-stream')){for(const data of text.split('\\n'))if(data.startsWith('data: '))process.stdout.write(data.slice(6)+'\\n')}else process.stdout.write(text+'\\n')
}catch{if(value.id!==undefined)console.log(JSON.stringify({jsonrpc:'2.0',id:value.id,error:{code:-32000,message:'Reservation broker unavailable'}}))}}`;
    await writeFile(mcp, bridge, { mode: 0o600 });
    await mkdir(join(home, '.codex'), { recursive: true, mode: 0o700 });
    await writeFile(join(home, '.codex', 'config.toml'), `model_provider = "reservation"\nmodel = ${JSON.stringify(input.model)}\n[model_providers.reservation]\nname = "Reservation scoped provider"\nbase_url = ${JSON.stringify(input.broker.url + '/ai')}\nenv_key = "OPENAI_API_KEY"\nwire_api = "responses"\n`, { mode: 0o600 });
  }
  }
  const environment: Record<string, string> = { HOME: '/home/reservation', CLAUDE_CONFIG_DIR: '/home/reservation/.claude', CODEX_HOME: '/home/reservation/.codex',
    CLAUDE_CODE_ENTRYPOINT: 'remote_mobile', ANTHROPIC_BASE_URL: input.broker.url + '/ai', ANTHROPIC_AUTH_TOKEN: input.broker.token,
    OPENAI_API_KEY: input.broker.token, SAYCODE_RESERVATION_BROKER: input.broker.url, SAYCODE_RESERVATION_CAPABILITY: input.broker.token,
    HTTP_PROXY: 'http://egress:8080', HTTPS_PROXY: 'http://egress:8080', NODE_USE_ENV_PROXY: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' };
  const projectEnvironment = Object.fromEntries(Object.entries(input.projectEnvironment ?? {}).filter(([key, value]) => !/^(GIT|SSH|HAPPY|APLUS|GH|GITHUB|ANTHROPIC|OPENAI|CLAUDE|CODEX|SAYCODE|HOME|PATH|HTTP_PROXY|HTTPS_PROXY|NODE_OPTIONS)(?:_|$)/i.test(key) && !/[\r\n\0]/.test(value)));
  const envFile = join(directory, 'native.env'), toolEnvFile = join(directory, 'tool.env');
  await writeFile(envFile, Object.entries(input.commandsOnly ? { HOME: '/home/reservation', HTTP_PROXY: 'http://egress:8080', HTTPS_PROXY: 'http://egress:8080', NODE_USE_ENV_PROXY: '1' } : environment).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  await writeFile(toolEnvFile, Object.entries({ ...projectEnvironment, HOME: '/home/reservation', NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://egress:8080', HTTPS_PROXY: 'http://egress:8080' }).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  return { directory, mounts, envFile, toolEnvFile, mcpConfig: '/home/reservation/' + (descriptor.agent === 'claude' ? 'mcp.json' : 'mcp-bridge.mjs'),
    async commit(requireProgress = false) {
      if (input.commandsOnly) throw new Error('RESERVATION_COMMAND_STATE_UNAVAILABLE');
      const next = await regular(state);
      if (next.length < source.length || !next.subarray(0, source.length).equals(source) || requireProgress && hash(next) === sourceHash) throw new Error('RESERVATION_NATIVE_STATE_UNCONFIRMED');
      const existing = hash(await regular(input.sourceTranscript));
      if (existing === hash(next)) return;
      if (existing !== sourceHash) throw new Error('RESERVATION_NATIVE_STATE_CHANGED');
      const temporary = input.sourceTranscript + '.reservation-' + descriptor.runId;
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(next); await file.sync(); } finally { await file.close(); }
      await rename(temporary, input.sourceTranscript);
      const parent = await open(dirname(input.sourceTranscript), 'r'); try { await parent.sync(); } finally { await parent.close(); }
    },
    async close() { await rm(directory, { recursive: true, force: true }); },
  };
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}

type NativeNetwork = { name: string; close(): Promise<void> };
/** Native egress is limited to its credential broker and public package registries used by project checks. */
export async function prepareReservationNativeNetwork(input: { scope: ReservationContainerScope; image: string; directory: string; brokerUrl?: string; allowedOrigins?: string[]; privateOrigins?: string[]; onPrepared?(network: NativeNetwork): void }) {
  const name = `happy-reservation-net-${createHash('sha256').update(JSON.stringify(input.scope)).digest('hex').slice(0, 24)}`;
  const proxy = name + '-egress', script = join(input.directory, 'egress.mjs');
  await copyFile(join(projectPath(), 'scripts', 'script-egress-proxy.mjs'), script); await chmod(script, 0o444);
  const args = (role: string) => Object.entries(reservationContainerLabels(input.scope, role)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const engine = () => reservationDocker.command(['info', '--format', '{{.ID}}']);
  const engineId = await engine(); if (!engineId.trim()) throw new Error('RESERVATION_NETWORK_UNAVAILABLE');
  let closed = false;
  const matching = async (role: string, network = false) => (await reservationDocker.command(network
    ? ['network', 'ls', '--format', '{{.Name}}', ...Object.entries(reservationContainerLabels(input.scope, role)).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`])]
    : ['ps', '-aq', ...Object.entries(reservationContainerLabels(input.scope, role)).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`])])).trim().split(/\s+/).filter(Boolean);
  const handle: NativeNetwork = { name, async close() {
    if (closed) return;
    if (await engine() !== engineId) throw new Error('RESERVATION_ENGINE_CHANGED');
    const proxies = await matching('egress'); if (proxies.length > 1) throw new Error('RESERVATION_NETWORK_CONTEXT_MISMATCH');
    if (proxies.length) {
      const row = JSON.parse(await reservationDocker.command(['inspect', proxies[0]]))[0];
      if (row?.Name !== '/' + proxy || Object.entries(reservationContainerLabels(input.scope, 'egress')).some(([key, value]) => row.Config?.Labels?.[key] !== value)) throw new Error('RESERVATION_NETWORK_CONTEXT_MISMATCH');
      await reservationDocker.command(['rm', '--force', proxies[0]]);
    }
    if ((await matching('egress')).length) throw new Error('RESERVATION_NETWORK_CLEANUP_UNCONFIRMED');
    const networks = await matching('network', true); if (networks.length > 1 || networks.length && networks[0] !== name) throw new Error('RESERVATION_NETWORK_CONTEXT_MISMATCH');
    if (networks.length) {
      const row = JSON.parse(await reservationDocker.command(['network', 'inspect', name]))[0];
      if (Object.keys(row.Containers ?? {}).length || row.Internal !== true) throw new Error('RESERVATION_NETWORK_CLEANUP_UNCONFIRMED');
      await reservationDocker.command(['network', 'rm', name]);
    }
    if ((await matching('network', true)).length || await engine() !== engineId) throw new Error('RESERVATION_NETWORK_CLEANUP_UNCONFIRMED');
    closed = true;
  } };
  input.onPrepared?.(handle); // Retain cleanup ownership even if a create/start acknowledgement is lost.
  try {
    await reservationDocker.command(['network', 'create', '--internal', '--opt', 'com.docker.network.bridge.gateway_mode_ipv4=isolated', ...args('network'), name]);
    const publicRegistries = ['https://registry.npmjs.org', 'https://pypi.org', 'https://files.pythonhosted.org'];
    await reservationDocker.command(['create', '--name', proxy, '--pull=never', ...args('egress'), '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--network', 'bridge', '--pids-limit', '16', '--memory', '128m',
      ...(process.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '--env', `SCRIPT_ALLOWED_ORIGINS=${JSON.stringify(input.brokerUrl ? [input.brokerUrl, ...publicRegistries] : input.allowedOrigins ?? [])}`, '--env', `SCRIPT_PRIVATE_ORIGINS=${JSON.stringify(input.brokerUrl ? [input.brokerUrl] : input.privateOrigins ?? [])}`,
      '--mount', `type=bind,src=${script},dst=/egress.mjs,readonly`, '--entrypoint', 'node', input.image, '/egress.mjs']);
    await reservationDocker.command(['network', 'connect', '--alias', 'egress', name, proxy]); await reservationDocker.command(['start', proxy]);
    await reservationDocker.command(['exec', proxy, 'node', '-e', `let n=0;function probe(){const s=require('net').connect(8080,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});s.on('error',()=>{if(++n===20)process.exit(1);setTimeout(probe,100)})}probe()`]);
  } catch { await handle.close(); throw new Error('RESERVATION_NETWORK_UNAVAILABLE'); }
  return handle;
}
