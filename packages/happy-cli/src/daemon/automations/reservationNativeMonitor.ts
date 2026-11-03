import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReservationPreparationContext } from './reservationConversationTurn';
import { ReservationNativeContainers, type ReservationContainer, type ReservationContainerScope } from './reservationNativeContainer';
import { prepareReservationNativeNetwork, prepareReservationNativeWorkspace } from './reservationNativeWorkspace';

type WorkspaceInput = Parameters<typeof prepareReservationNativeWorkspace>[0];
/** Credential-free command stage. Its entire kernel boundary is gone before native/provider credentials exist. */
export class ReservationNativeMonitor {
  private handle?: ReservationContainer;
  private workspace?: Awaited<ReturnType<typeof prepareReservationNativeWorkspace>>;
  private network?: Awaited<ReturnType<typeof prepareReservationNativeNetwork>>;
  private engineId?: string;
  private signal?: AbortSignal;
  private failed = false;
  private closed = false;
  constructor(private readonly containers: ReservationNativeContainers, private readonly input: {
    scope: ReservationContainerScope; image: string; workspace: WorkspaceInput;
    allowedOrigins: string[]; privateOrigins: string[]; userSignal: AbortSignal;
  }) {}
  async prepare(context: ReservationPreparationContext & { recordIntent(engineId: string, directory: string): void }): Promise<void> {
    this.signal = AbortSignal.any([context.signal, this.input.userSignal]); this.signal.throwIfAborted();
    this.workspace = await prepareReservationNativeWorkspace({ ...this.input.workspace, commandsOnly: true });
    this.engineId = await this.containers.engine();
    context.recordIntent(this.engineId, this.workspace.directory); // fsync before ANY Docker create, including the egress proxy.
    if (this.input.allowedOrigins.length) this.network = await prepareReservationNativeNetwork({ scope: this.input.scope, image: this.input.image,
      directory: this.workspace.directory, allowedOrigins: this.input.allowedOrigins, privateOrigins: this.input.privateOrigins,
      onPrepared: network => { this.network = network; } });
    this.signal.throwIfAborted();
    this.handle = await this.containers.prepare({ scope: this.input.scope, image: this.input.image, mounts: this.workspace.mounts,
      network: this.network?.name, uid: process.getuid!(), gid: process.getgid!(), deadlineMonotonicMs: context.deadlineMonotonicMs });
    this.signal.throwIfAborted();
  }
  async renew(deadlineMonotonicMs: number): Promise<void> {
    if (this.handle && !this.closed) await this.containers.renew(this.handle, deadlineMonotonicMs);
  }
  async run(input: { command: string; notepad: Readonly<Record<string, string>> }): Promise<{ ok: boolean; stdout: string }> {
    this.signal?.throwIfAborted();
    if (!this.handle || !this.workspace || this.failed || this.closed) throw new Error('RESERVATION_COMMAND_SCOPE_UNAVAILABLE');
    const environmentFile = join(this.workspace.directory, 'monitor.env');
    // A JSON string can contain escaped newlines, but never inject env-file rows.
    const { readFile } = await import('node:fs/promises');
    await writeFile(environmentFile, await readFile(this.workspace.toolEnvFile, 'utf8') + '\nHAPPY_AUTOMATION_NOTEPAD=' + JSON.stringify(input.notepad), { mode: 0o600 });
    const child = await this.containers.execute(this.handle, { command: '/bin/sh', args: ['-c', input.command],
      cwd: this.input.workspace.descriptor.executionDirectory, uid: process.getuid!(), gid: process.getgid!(), environmentFile });
    return new Promise((resolve, reject) => {
      const stdout: Buffer[] = []; let size = 0, finished = false;
      const fail = () => { this.failed = true; if (!finished) { finished = true; reject(new Error('RESERVATION_MONITOR_FAILED')); } };
      const timer = setTimeout(fail, 30_000); timer.unref?.();
      this.signal!.addEventListener('abort', fail, { once: true });
      child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) fail(); else stdout.push(chunk); });
      child.stderr!.resume(); // Drain errors without leaking command output into host logs.
      child.once('error', fail);
      child.once('close', code => {
        clearTimeout(timer); this.signal!.removeEventListener('abort', fail);
        if (!finished) { finished = true; resolve({ ok: code === 0, stdout: Buffer.concat(stdout).toString('utf8') }); }
      });
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    // On a lost create/remove ACK, the journal's exact engine anchors a scoped inventory check.
    if (this.engineId) await this.containers.cleanupPreparation(this.input.scope, this.engineId);
    await this.workspace?.close(); this.closed = true;
  }
}
