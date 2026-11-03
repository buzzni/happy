import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { ReservationRuntimeIdentity } from '@slopus/happy-wire';
import { reservationMonotonicNow } from './reservationMonotonicClock';
import { sanitizeChildEnv } from '@/utils/childEnv';

const exec = promisify(execFile);
const immutable = /^(?:sha256:|[\w./:-]+@sha256:)[a-f0-9]{64}$/;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ReservationContainerScope = {
  role?: 'preparation'; owner: string; runId: string; sessionId: string; epoch: string; descriptorHash: string;
};
export type ReservationContainer = ReservationRuntimeIdentity & { id: string; engine: string; scope: ReservationContainerScope };
type Mount = { source: string; target: string; writable: boolean };
export type ReservationDocker = {
  command(args: string[]): Promise<string>;
  attach(args: string[]): ChildProcess;
};
export const reservationDocker: ReservationDocker = {
  command: async args => (await exec('docker', args, { timeout: 30000, maxBuffer: 1024 * 1024, env: sanitizeChildEnv(process.env), windowsHide: true })).stdout,
  attach: args => spawn('docker', args, { env: sanitizeChildEnv(process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
};
// PID 1 is a trusted root-owned lease gate. Native programs run under a different
// uid and cannot rewrite the gate. When PID 1 exits, the kernel tears down its
// PID namespace, including setsid/background descendants of docker exec.
const clockProbe = `process.stdout.write(String(Number(require('node:fs').readFileSync('/proc/uptime','utf8').split(' ')[0])*1000))`;
const gate = `const fs=require('node:fs');
const root='/run/reservation-authority';fs.mkdirSync(root,{mode:448});
const boot=()=>Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])*1000;
const epoch=process.argv[1],hash=process.argv[2];
const deadline=Number(process.argv[3]);if(!Number.isFinite(deadline)||boot()>=deadline)process.exit(70);
fs.writeFileSync(root+'/lease',JSON.stringify({epoch,hash,deadline}),{mode:384});
setInterval(()=>{try{const v=JSON.parse(fs.readFileSync(root+'/lease','utf8'));
if(v.epoch!==epoch||v.hash!==hash||!Number.isFinite(v.deadline)||boot()>=v.deadline)process.exit(70)}catch{process.exit(71)}},100);
process.on('SIGTERM',()=>process.exit(72));`;
const renewal = `const fs=require('node:fs'),p='/run/reservation-authority/lease';
const v=JSON.parse(fs.readFileSync(p,'utf8')),now=Number(fs.readFileSync('/proc/uptime','utf8').split(' ')[0])*1000;
const deadline=Number(process.argv[3]);if(v.epoch!==process.argv[1]||v.hash!==process.argv[2]||now>=v.deadline||!Number.isFinite(deadline)||deadline<=now||deadline>now+90000)process.exit(73);
fs.writeFileSync(p,JSON.stringify({...v,deadline}),{mode:384});`;

function validateScope(scope: ReservationContainerScope) {
  if (!/^[a-f0-9]{64}$/.test(scope.owner) || !/^[a-f0-9]{64}$/.test(scope.descriptorHash)
    || [scope.runId, scope.sessionId, scope.epoch].some(value => !/^[A-Za-z0-9_-]{1,200}$/.test(value))) throw new Error('RESERVATION_CONTAINER_SCOPE_INVALID');
}
export const reservationContainerLabels = (scope: ReservationContainerScope, role = scope.role ?? 'runtime') => ({ 'happy.reservation.owner': scope.owner, 'happy.reservation.run': scope.runId,
  'happy.reservation.session': scope.sessionId, 'happy.reservation.epoch': scope.epoch, 'happy.reservation.descriptor': scope.descriptorHash, 'happy.reservation.role': scope.role && role !== scope.role ? `${scope.role}-${role}` : role });
const identity = (row: any, engine: string, scope: ReservationContainerScope): ReservationContainer => {
  if (!/^[a-f0-9]{64}$/.test(row.Id) || !row.State?.Running || !Number.isSafeInteger(row.State.Pid) || row.State.Pid <= 0
    || Object.entries(reservationContainerLabels(scope)).some(([key, value]) => row.Config?.Labels?.[key] !== value)) throw new Error('RESERVATION_CONTAINER_CONTEXT_MISMATCH');
  return { id: row.Id, engine, scope, launchId: row.Id, processGroupId: row.State.Pid,
    processStartId: digest([engine, row.Id, row.State.StartedAt]) };
};

/** Concrete Linux-container boundary, shared by provider and tool execution adapters. */
export class ReservationNativeContainers {
  constructor(private readonly docker: ReservationDocker = reservationDocker) {}
  private async kernelDeadline(deadline: number, probe: string[]): Promise<number> {
    let remaining = deadline - reservationMonotonicNow();
    if (remaining <= 100 || remaining > 90000) throw new Error('RESERVATION_AUTHORITY_EXPIRED');
    const boot = Number(await this.docker.command(probe));
    // The sample predates this receipt. Subtract the entire probe ACK latency and a clock-resolution margin.
    remaining = Math.floor(deadline - reservationMonotonicNow() - 100);
    if (!Number.isFinite(boot) || boot <= 0 || remaining <= 0) throw new Error('RESERVATION_AUTHORITY_EXPIRED');
    return Math.floor(boot + remaining);
  }
  async engine(): Promise<string> {
    const value = JSON.parse(await this.docker.command(['info', '--format', '{{json .}}']));
    if (value.OSType !== 'linux' || typeof value.ID !== 'string' || !value.ID) throw new Error('RESERVATION_LINUX_ENGINE_REQUIRED');
    return value.ID;
  }
  async prepare(input: { scope: ReservationContainerScope; image: string; mounts: Mount[]; uid: number; gid: number; deadlineMonotonicMs: number; network?: string }): Promise<ReservationContainer> {
    validateScope(input.scope);
    if (!immutable.test(input.image) || !Number.isSafeInteger(input.uid) || input.uid <= 0 || !Number.isSafeInteger(input.gid) || input.gid < 0) throw new Error('RESERVATION_CONTAINER_PROFILE_INVALID');
    const remaining = Math.floor(input.deadlineMonotonicMs - reservationMonotonicNow());
    if (remaining <= 1000 || remaining > 90000) throw new Error('RESERVATION_AUTHORITY_EXPIRED');
    const engine = await this.engine();
    const mounts: string[] = [], destinations = new Set<string>();
    for (const mount of input.mounts) {
      const canonical = await realpath(mount.source);
      if (canonical !== mount.source || /[,\x00-\x1f]/.test(canonical) || !mount.target.startsWith('/') || /[,\x00-\x1f]/.test(mount.target)
        || mount.target.split('/').includes('..') || /^\/(?:proc|sys|dev|run|var\/run)(?:\/|$)/.test(mount.target)
        || mount.target === '/' || destinations.has(mount.target) || !(await stat(canonical)).isDirectory()) throw new Error('RESERVATION_MOUNT_INVALID');
      destinations.add(mount.target);
      mounts.push('--mount', `type=bind,src=${canonical},dst=${mount.target}${mount.writable ? '' : ',readonly'}`);
    }
    if (input.network) {
      const rows = JSON.parse(await this.docker.command(['network', 'inspect', input.network]));
      if (rows.length !== 1 || rows[0].Internal !== true || Object.entries(reservationContainerLabels(input.scope, 'network')).some(([key, value]) => rows[0].Labels?.[key] !== value)) throw new Error('RESERVATION_NETWORK_INVALID');
    }
    const deadline = await this.kernelDeadline(input.deadlineMonotonicMs, ['run', '--rm', '--pull=never', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65534:65534', '--pids-limit', '16', '--memory', '128m', '--entrypoint', 'node', input.image, '-e', clockProbe]);
    const name = `happy-reservation-${digest(input.scope).slice(0, 32)}`;
    const id = (await this.docker.command(['create', '--name', name, '--pull=never', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--user', '0:0', '--pids-limit', '256', '--memory', '2g', '--cpus', '2', '--network', input.network ?? 'none',
      '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--tmpfs', '/run:rw,nosuid,nodev,noexec,size=1m',
      ...Object.entries(reservationContainerLabels(input.scope)).flatMap(([key, value]) => ['--label', `${key}=${value}`]), ...mounts,
      '--entrypoint', 'node', input.image, '-e', gate, input.scope.epoch, input.scope.descriptorHash, String(deadline)])).trim();
    // A create/start ACK may be lost. The deterministic name and scope labels
    // remain discoverable; no failure here asserts that nothing started.
    await this.docker.command(['start', id]);
    const row = JSON.parse(await this.docker.command(['inspect', id]))[0];
    return identity(row, engine, input.scope);
  }
  async renew(handle: ReservationContainer, deadlineMonotonicMs: number): Promise<void> {
    await this.verify(handle);
    const deadline = await this.kernelDeadline(deadlineMonotonicMs, ['exec', handle.id, 'node', '-e', clockProbe]);
    await this.docker.command(['exec', '--user', '0:0', handle.id, 'node', '-e', renewal, handle.scope.epoch, handle.scope.descriptorHash, String(deadline)]);
  }
  async verify(handle: ReservationContainer): Promise<void> {
    if (await this.engine() !== handle.engine) throw new Error('RESERVATION_ENGINE_CHANGED');
    const current = identity(JSON.parse(await this.docker.command(['inspect', handle.id]))[0], handle.engine, handle.scope);
    if (current.processGroupId !== handle.processGroupId || current.processStartId !== handle.processStartId) throw new Error('RESERVATION_CONTAINER_CONTEXT_MISMATCH');
  }
  async execute(handle: ReservationContainer, input: { command: string; args: string[]; cwd: string; uid: number; gid: number; environmentFile?: string }): Promise<ChildProcess> {
    await this.verify(handle);
    if (input.uid <= 0 || !Number.isSafeInteger(input.uid) || input.gid < 0 || !Number.isSafeInteger(input.gid)
      || !input.cwd.startsWith('/') || input.command.includes('\0') || input.args.some(value => value.includes('\0'))) throw new Error('RESERVATION_EXEC_INVALID');
    return this.docker.attach(['exec', '--interactive', '--user', `${input.uid}:${input.gid}`, '--workdir', input.cwd,
      ...(input.environmentFile ? ['--env-file', input.environmentFile] : []), handle.id, input.command, ...input.args]);
  }
  /** A durable intent recorded on this exact engine anchors absence after a lost create/remove ACK. Preparation only. */
  async cleanupPreparation(scope: ReservationContainerScope, engineId: string): Promise<void> {
    validateScope(scope);
    if (scope.role !== 'preparation' || await this.engine() !== engineId) throw new Error('RESERVATION_ENGINE_CHANGED');
    for (const role of ['preparation', 'egress', 'network']) {
      const filters = Object.entries(reservationContainerLabels(scope, role)).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`]);
      const list = role === 'network' ? ['network', 'ls', '-q', ...filters] : ['ps', '-aq', ...filters];
      const ids = (await this.docker.command(list)).trim().split(/\s+/).filter(Boolean);
      if (ids.length > 1) throw new Error('RESERVATION_PREPARATION_CONTEXT_MISMATCH');
      if (ids.length) await this.docker.command(role === 'network' ? ['network', 'rm', ids[0]] : ['rm', '--force', ids[0]]);
      if ((await this.docker.command(list)).trim() || await this.engine() !== engineId) throw new Error('RESERVATION_PREPARATION_CLEANUP_UNCONFIRMED');
    }
  }
  async stop(scope: ReservationContainerScope, expected?: ReservationRuntimeIdentity): Promise<{ exited: boolean; runtime?: ReservationRuntimeIdentity }> {
    validateScope(scope);
    const engine = await this.engine();
    const ids = (await this.docker.command(['ps', '-aq', ...Object.entries(reservationContainerLabels(scope)).flatMap(([key, value]) => ['--filter', `label=${key}=${value}`])])).trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) return { exited: false }; // Absence or a second launch is not exit evidence.
    const row = JSON.parse(await this.docker.command(['inspect', ids[0]]))[0];
    if (Object.entries(reservationContainerLabels(scope)).some(([key, value]) => row.Config?.Labels?.[key] !== value)) return { exited: false };
    if (expected && (row.Id !== expected.launchId || digest([engine, row.Id, row.State.StartedAt]) !== expected.processStartId)) return { exited: false };
    const runtime = expected ?? (row.State.Running ? identity(row, engine, scope) : undefined);
    await this.docker.command(['rm', '--force', row.Id]);
    // rm ACK is a whole-cgroup removal, not the exit of the local docker attach client.
    // Recheck the same engine and exact labelled scope before issuing a receipt.
    if (await this.engine() !== engine) return { exited: false };
    const remaining = (await this.docker.command(['ps', '-aq', '--filter', `id=${row.Id}`])).trim();
    return remaining ? { exited: false } : { exited: true, runtime };
  }
}
