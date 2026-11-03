import type { ReservationRunJournal } from './reservationRunJournal';

/** Owns detached turns without detaching their per-reservation/session admission. */
export class ReservationBackgroundRuns {
  private readonly active = new Map<string, { sessionId: string; github: boolean; done: Promise<void> }>();
  constructor(private readonly journal: ReservationRunJournal, private readonly log: (message: string) => void) {}
  busy(automationId: string, sessionId: string): boolean {
    if (this.active.has(automationId) || [...this.active.values()].some(row => row.sessionId === sessionId)) return true;
    try { return this.journal.blocks(automationId, sessionId); }
    catch { this.log('[reservation] journal unavailable; native admission denied'); return true; }
  }
  reserve(automationId: string, sessionId: string, options?: { github: boolean }): { start(work: () => Promise<void>): void; release(): void } | null {
    if (this.busy(automationId, sessionId)) return null;
    let resolve!: () => void, started = false, released = false;
    const entry = { sessionId, github: options?.github === true, done: new Promise<void>(done => { resolve = done; }) };
    this.active.set(automationId, entry);
    const release = () => {
      if (released) return;
      released = true;
      if (this.active.get(automationId) === entry) this.active.delete(automationId);
      resolve();
    };
    return {
      release,
      start: work => {
        if (started || released) throw new Error('RESERVATION_SLOT_CLOSED');
        started = true;
        void Promise.resolve().then(work).catch(() => this.log('[reservation] background completion unconfirmed; journal retained')).finally(release);
      },
    };
  }
  start(automationId: string, sessionId: string, work: () => Promise<void>): boolean {
    const slot = this.reserve(automationId, sessionId);
    if (!slot) return false;
    slot.start(work); return true;
  }
  hasSession(sessionId: string): boolean {
    return [...this.active.values()].some(row => row.sessionId === sessionId);
  }
  get githubCount(): number { return [...this.active.values()].filter(row => row.github).length; }
  get count(): number { return this.active.size; }
  async drain(): Promise<void> { await Promise.all([...this.active.values()].map(row => row.done)); }
}
