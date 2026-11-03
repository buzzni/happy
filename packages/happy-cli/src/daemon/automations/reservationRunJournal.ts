import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { reservationDescriptorHash, type ReservationTurnDependencies, type ReservationTurnDescriptor } from './reservationConversationTurn';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reservationExitProofSchema, reservationRuntimeIdentitySchema, type ReservationExitProof, type ReservationLeaseRequest, type ReservationRuntimeIdentity } from '@slopus/happy-wire';

const id = z.string().min(1).max(200);
const rowSchema = z.strictObject({ automationId: id, generation: z.number().int().positive(), runId: id, sessionId: id,
  descriptorHash: z.string().regex(/^[a-f0-9]{64}$/), claimToken: z.string().min(1).max(512), expectedSeq: z.number().int().nonnegative(),
  state: z.enum(['ACQUIRING', 'PREPARING', 'RUNNING', 'SETTLING']), epoch: id.optional(), launchIntent: z.boolean(),
  preparation: z.strictObject({ engineId: id, directory: z.string().min(1).max(4096).optional(), cleaned: z.boolean().optional() }).optional(),
  runtime: reservationRuntimeIdentitySchema.optional(), stored: z.boolean().optional(), proof: reservationExitProofSchema.nullable().optional(),
});
export type ReservationJournalRun = z.infer<typeof rowSchema>;
type Seed = Omit<ReservationJournalRun, 'state' | 'epoch' | 'launchIntent' | 'runtime' | 'stored' | 'proof' | 'preparation'>;
type Receipt = { stored: boolean; proof: ReservationExitProof | null };

/** Owner-only daemon journal. Recovery can stop and settle; it cannot start or deliver. */
export class ReservationRunJournal {
  constructor(private readonly file: string) {}
  pending(): ReservationJournalRun[] {
    let fd: number | undefined;
    try {
      fd = openSync(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      return z.strictObject({ version: z.literal(1), runs: z.array(rowSchema).max(1000) }).parse(JSON.parse(readFileSync(fd, 'utf8'))).runs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error('RESERVATION_JOURNAL_INVALID');
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  blocks(automationId: string, sessionId: string): boolean {
    return this.pending().some(row => row.automationId === automationId || row.sessionId === sessionId);
  }
  private write(runs: ReservationJournalRun[]): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, JSON.stringify({ version: 1, runs })); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, this.file);
      const parent = openSync(dirname(this.file), constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  private update(runId: string, change: (run: ReservationJournalRun) => ReservationJournalRun): void {
    const rows = this.pending();
    if (!rows.some(row => row.runId === runId)) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
    this.write(rows.map(row => row.runId === runId ? rowSchema.parse(change(row)) : row));
  }
  begin(seed: Seed): void {
    const row = rowSchema.parse({ ...seed, state: 'ACQUIRING', launchIntent: false });
    const rows = this.pending(), previous = rows.find(item => item.runId === row.runId);
    if (previous) {
      if (Object.entries(seed).some(([key, value]) => previous[key as keyof Seed] !== value)) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
      throw new Error('RESERVATION_JOURNAL_RECOVERY_REQUIRED');
    }
    if (rows.some(item => item.automationId === row.automationId || item.sessionId === row.sessionId)) throw new Error('RESERVATION_JOURNAL_BUSY');
    this.write([...rows, row]);
  }
  checkpoint(runId: string, state: ReservationJournalRun['state'], epoch?: string): void {
    this.update(runId, row => {
      const order = ['ACQUIRING', 'PREPARING', 'RUNNING', 'SETTLING'];
      if (row.epoch && epoch !== row.epoch || order.indexOf(state) < order.indexOf(row.state) || state !== 'ACQUIRING' && !epoch) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
      return { ...row, state, ...(epoch ? { epoch } : {}) };
    });
  }
  preparingCommands(runId: string, engineId: string, directory?: string): void {
    this.update(runId, row => {
      if (row.state !== 'PREPARING' || !row.epoch || row.preparation || row.launchIntent) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
      return { ...row, preparation: { engineId, ...(directory ? { directory } : {}) } };
    });
  }
  launching(runId: string): void {
    this.update(runId, row => {
      if (row.state !== 'PREPARING' || !row.epoch || row.launchIntent) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
      return { ...row, launchIntent: true };
    });
  }
  launched(runId: string, runtime: ReservationRuntimeIdentity): void {
    this.update(runId, row => {
      if (!row.launchIntent || row.runtime) throw new Error('RESERVATION_JOURNAL_CONTEXT_MISMATCH');
      return { ...row, runtime };
    });
  }
  cleaned(runId: string, receipt: Receipt): void {
    this.update(runId, row => ({ ...row, state: 'SETTLING', ...receipt, proof: receipt.proof ?? row.proof ?? null }));
  }
  released(runId: string): void { this.write(this.pending().filter(row => row.runId !== runId)); }
  bind(descriptor: ReservationTurnDescriptor, claimToken: string, deps: ReservationTurnDependencies): ReservationTurnDependencies {
    const descriptorHash = reservationDescriptorHash(descriptor);
    let startedRuntime: ReservationRuntimeIdentity | null = null;
    return { ...deps,
      ...(deps.prepareCommands ? { prepareCommands: async (value: Parameters<NonNullable<ReservationTurnDependencies['prepareCommands']>>[0]) => deps.prepareCommands!({ ...value, recordIntent: (engineId, directory) => this.preparingCommands(descriptor.runId, engineId, directory) }) } : {}),
      ...(deps.finishPreparation ? { finishPreparation: async () => {
        await deps.finishPreparation!();
        this.update(descriptor.runId, row => row.preparation ? { ...row, preparation: { ...row.preparation, cleaned: true } } : row);
      } } : {}),
      prepare: async value => {
        const prepared = await deps.prepare(value);
        this.begin({ automationId: value.automationId, generation: value.generation, runId: value.runId,
          sessionId: value.sessionId, descriptorHash, claimToken, expectedSeq: prepared.expectedSeq });
        return prepared;
      },
      lease: async request => {
        const result = await deps.lease(request);
        if (request.operation === 'acquire' && !result.ok && ['claim-cancelled', 'target-mismatch', 'reservation-busy', 'session-changed', 'invalid-input', 'reservation-context-mismatch'].includes(result.error)) this.released(descriptor.runId);
        return result;
      },
      checkpoint: async value => {
        if (value.state === 'RELEASED') this.released(value.runId);
        else this.checkpoint(value.runId, value.state, value.epoch);
        await deps.checkpoint(value);
      },
      start: async value => {
        this.launching(descriptor.runId);
        const runtime = await deps.start(value); startedRuntime = runtime;
        this.launched(descriptor.runId, { launchId: runtime.launchId, processGroupId: runtime.processGroupId, processStartId: runtime.processStartId });
        return runtime;
      },
      finish: async value => {
        const receipt = await deps.finish({ ...value, handle: value.handle ?? startedRuntime });
        this.cleaned(descriptor.runId, receipt); return receipt;
      },
    };
  }
  async recover(deps: {
    now(): number;
    lease(request: ReservationLeaseRequest): Promise<{ ok: boolean; value?: { epoch: string; state: string; runId?: string; sessionId?: string; descriptorHash?: string }; error?: string }>;
    /** Must withdraw all native/tool authority and prove exit, even when the start ACK was lost. */
    finish(row: ReservationJournalRun): Promise<Receipt>;
  }): Promise<void> {
    for (const initial of this.pending()) {
      if (!initial.epoch) {
        // Recover only the original claim. This RPC withdraws authority; it never renews it.
        try {
          const recovered = await deps.lease({ wireVersion: 1, operation: 'recover', runId: initial.runId,
            claimToken: initial.claimToken, sessionId: initial.sessionId, descriptorHash: initial.descriptorHash });
          if (!recovered.ok) {
            if (recovered.error === 'reservation-not-found' && !initial.launchIntent) this.released(initial.runId);
            continue;
          }
          const value = recovered.value;
          if (!value || value.state !== 'SETTLING' || value.runId !== initial.runId || value.sessionId !== initial.sessionId || value.descriptorHash !== initial.descriptorHash) continue;
          initial.epoch = value.epoch;
        } catch { continue; }
      }
      const epoch = initial.epoch;
      const base = { wireVersion: 1 as const, runId: initial.runId, claimToken: initial.claimToken, sessionId: initial.sessionId, epoch };
      this.checkpoint(initial.runId, 'SETTLING', epoch);
      let receipt: Receipt = { stored: initial.stored === true, proof: initial.proof ?? null };
      try {
        if (!receipt.stored || !receipt.proof) receipt = initial.launchIntent || initial.preparation && !initial.preparation.cleaned
          ? await deps.finish(initial)
          : { stored: true, proof: { status: 'not-started', epoch, descriptorHash: initial.descriptorHash, verifiedAt: deps.now() } };
        this.cleaned(initial.runId, receipt);
        const settled = await deps.lease({ ...base, operation: 'settle' });
        if (!settled.ok || settled.value?.epoch !== epoch || settled.value.state !== 'SETTLING') continue;
        const proof = receipt.proof;
        if (!receipt.stored || !proof || proof.epoch !== epoch || proof.descriptorHash !== initial.descriptorHash || proof.verifiedAt > deps.now() + 5000
          || initial.runtime && proof.status !== 'exited'
          || proof.status === 'exited' && initial.runtime && (proof.launchId !== initial.runtime.launchId || proof.processGroupId !== initial.runtime.processGroupId || proof.processStartId !== initial.runtime.processStartId)) continue;
        const result = await deps.lease({ ...base, operation: 'release', proof });
        if (result.ok && result.value?.epoch === epoch && result.value.state === 'RELEASED') this.released(initial.runId);
      } catch { /* Retain the original identity and receipt for cleanup replay, never execution replay. */ }
    }
  }
}
