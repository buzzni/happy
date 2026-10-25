/** Runtime input witnesses. This is deliberately independent of AutomationTurnTracker's single-run arming. */
import { randomUUID } from 'node:crypto';
import { createEnvelope, hubPromptGuardSchema, inputRefSchema, type HubInputAdmissionV1,
    type InputEvidenceV1, type InputRef, type SessionEnvelope } from '@slopus/happy-wire';

export type EvidenceBatch = { inputs: InputRef[]; inputCount: number; continuation?: InputEvidenceV1; incompleteReasons?: string[] };
type AdditionalKind = InputEvidenceV1['additional']['items'][number]['kind'];
type AttemptState = InputEvidenceV1['additional']['items'][number]['state'];
type ContinuationKind = InputEvidenceV1['continuation']['kind'];
export type QueueInputEvidence = { ref: InputRef; guard?: unknown; continuation?: InputEvidenceV1 };

/** Host state, never inferred from delayed metadata echoes. Calls and transitions are synchronous. */
export class HubInputGate {
    mode: 'remote' | 'local' | 'transitioning' = 'transitioning';
    modeEpoch = 0;
    constructor(readonly sessionId: string, readonly runtimeId: string, readonly managed: boolean) {}
    transition(mode: HubInputGate['mode']): boolean {
        if (mode === this.mode) return false;
        this.mode = mode;
        this.modeEpoch += 1;
        return true;
    }
    check(input: QueueInputEvidence): HubInputAdmissionV1 | null {
        if (input.guard === undefined) return null;
        const parsed = hubPromptGuardSchema.safeParse(input.guard);
        const guard = parsed.success ? parsed.data : null;
        const reason: HubInputAdmissionV1['reason'] = !guard || guard.targetSessionId !== this.sessionId || this.managed
            ? 'invalid-guard' : guard.expectedRuntimeId !== this.runtimeId ? 'runtime-mismatch'
            : guard.expectedModeEpoch !== this.modeEpoch ? 'mode-changed' : this.mode !== 'remote' ? 'mode-mismatch' : 'matched';
        // Runtime-only identity is required; a payload localKey is not an admission witness.
        if (input.ref.kind !== 'rest') return null;
        return { t: 'hub-input-admission', v: 1, serverMessageId: input.ref.serverMessageId, targetSessionId: this.sessionId,
            expectedRuntimeId: guard?.expectedRuntimeId ?? null, observedRuntimeId: this.runtimeId,
            expectedModeEpoch: guard?.expectedModeEpoch ?? null, observedModeEpoch: this.modeEpoch,
            state: reason === 'matched' ? 'accepted' : 'rejected', reason };
    }
}

export class TurnInputEvidence {
    private pending: EvidenceBatch | null = null;
    private readonly turns = new Map<string, InputEvidenceV1>();
    private current: string | null = null;
    private last: string | null = null;
    private carry: InputEvidenceV1 | null = null;
    private readonly backgroundTurns = new Map<string, string>();
    rememberBackground(id: string, turn: string): void {
        this.backgroundTurns.set(id, turn);
        while (this.backgroundTurns.size > 200) this.backgroundTurns.delete(this.backgroundTurns.keys().next().value!);
    }
    rearmBackground(ids: string[]): void {
        const turn = ids.map(id => this.backgroundTurns.get(id)).find(Boolean);
        for (const id of ids) this.backgroundTurns.delete(id);
        const source = turn ? this.snapshot(turn) : null;
        if (!source) return;
        if (this.current) { this.incomplete('background-co-consumption'); return; }
        if (this.pending) {
            this.pending.incompleteReasons = [...(this.pending.incompleteReasons ?? []), 'background-co-consumption'];
            return;
        }
        source.continuation = { kind: 'background', state: 'pending', retryId: null,
            previousTurn: { runtimeId: this.runtimeId, turnId: source.turnId },
            rootExclusive: source.inputCount === 1 && source.coverage === 'complete' && source.additional.attempted === 0
                && source.continuation.rootExclusive !== false };
        this.pending = { inputs: [], inputCount: 0, continuation: source };
    }
    constructor(readonly runtimeId: string, private readonly emit: (envelope: SessionEnvelope) => void) {}
    currentTurn(): string | null { return this.current; }
    setPending(batch: EvidenceBatch | null): void { this.pending = batch; }
    snapshot(turn = this.current ?? this.last): InputEvidenceV1 | null {
        return turn && this.turns.has(turn) ? structuredClone(this.turns.get(turn)!) : null;
    }
    private fit(value: InputEvidenceV1): void {
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536) return;
        value.coverage = 'incomplete';
        if (!value.incompleteReasons.includes('evidence-size')) value.incompleteReasons = [...value.incompleteReasons.slice(0, 31), 'evidence-size'];
        while (value.inputs.length && Buffer.byteLength(JSON.stringify(value), 'utf8') > 65536) value.inputs.pop();
    }
    private publish(value: InputEvidenceV1): void {
        this.fit(value);
        value.revision += 1;
        this.emit(createEnvelope('agent', { t: 'turn-input-evidence', inputEvidence: structuredClone(value) }, { turn: value.turnId }));
    }
    incomplete(reason: string, turn = this.current ?? this.last): void {
        const value = turn ? this.turns.get(turn) : null;
        if (!value) return;
        value.coverage = 'incomplete';
        if (!value.incompleteReasons.includes(reason) && value.incompleteReasons.length < 32) value.incompleteReasons.push(reason);
        this.publish(value);
    }
    /** Called before the provider write. The returned token stays tied to that turn across awaits. */
    attempt(kind: AdditionalKind, turn: string | null = this.current): { settle(state: Exclude<AttemptState, 'pending'>): void } {
        const value = turn ? this.turns.get(turn) : null;
        if (!value) {
            if (this.current) this.incomplete('additional-turn-unresolved', this.current);
            if (this.pending) this.pending.incompleteReasons = [...(this.pending.incompleteReasons ?? []), 'additional-turn-unresolved'];
            return { settle: () => undefined };
        }
        const item: InputEvidenceV1['additional']['items'][number] = { attemptId: randomUUID(), kind, state: 'pending' };
        value.additional.attempted += 1;
        const ordinal = value.additional.attempted;
        value.additional.pending += 1;
        if (value.additional.items.length < 128) value.additional.items.push(item);
        else this.incomplete('additional-limit', value.turnId);
        this.publish(value);
        let settled = false;
        return { settle: state => {
            if (settled) return;
            settled = true;
            // A provider restart can begin a continuation while this ACK is still in flight.
            // Settle every descendant that inherited the attempt, never a different input root.
            const descendants = [...this.turns.values()].filter(candidate => candidate !== value
                && candidate.rootBatchId === value.rootBatchId && candidate.additional.attempted >= ordinal);
            for (const candidate of [value, ...descendants]) {
                candidate.additional.pending -= 1;
                if (state !== 'rejected') candidate.additional[state] += 1;
                const inheritedItem = candidate.additional.items.find(entry => entry.attemptId === item.attemptId);
                if (inheritedItem) inheritedItem.state = state;
                this.publish(candidate);
            }
        } };
    }
    /** A decision to retry (or to wait for an account) must precede the failed terminal. */
    continuePending(kind: ContinuationKind): void {
        const value = this.snapshot();
        if (!value) return;
        const live = this.turns.get(value.turnId)!;
        if (live.continuation.state === 'pending' && live.continuation.kind === kind) return;
        live.continuation = { kind, state: 'pending', previousTurn: { runtimeId: this.runtimeId, turnId: live.turnId },
            retryId: randomUUID(), rootExclusive: live.inputCount === 1 && live.coverage === 'complete' && live.additional.attempted === 0
                && live.continuation.rootExclusive !== false };
        live.terminal = false;
        this.carry = live;
        this.publish(live);
    }
    isContinuationCurrent(value: InputEvidenceV1): boolean {
        return this.carry !== null && this.carry.continuation.state === 'pending'
            && this.carry.continuation.retryId === value.continuation.retryId
            && this.carry.turnId === value.turnId && this.carry.runtimeId === value.runtimeId;
    }
    takeContinuation(): InputEvidenceV1 | undefined {
        if (!this.carry || this.carry.continuation.state !== 'pending') return undefined;
        const result = structuredClone(this.carry);
        return result;
    }
    cancelContinuation(state: 'cancelled' | 'replaced' | 'completed'): void {
        if (!this.carry) return;
        this.carry.continuation.state = state;
        this.carry.terminal = true;
        this.publish(this.carry);
        this.carry = null;
    }
    stamp(envelope: SessionEnvelope): SessionEnvelope {
        if (envelope.role !== 'agent' || envelope.subagent || !envelope.turn) return envelope;
        const { ev, turn } = envelope;
        if (ev.t === 'turn-start') {
            const batch = this.pending;
            this.pending = null;
            const inherited = batch?.continuation && this.isContinuationCurrent(batch.continuation)
                ? this.takeContinuation() : batch?.continuation;
            if (inherited && this.carry?.continuation.retryId === inherited.continuation.retryId) this.carry = null;
            const batchId = randomUUID();
            const inputs = inherited?.inputs ?? batch?.inputs ?? [];
            const reasons = [...(inherited?.incompleteReasons ?? []), ...(batch?.incompleteReasons ?? [])];
            if (!batch) reasons.push('unobserved-input');
            if (inputs.length > 256) reasons.push('input-limit');
            if (inputs.some(ref => !inputRefSchema.safeParse(ref).success)) reasons.push('invalid-input-ref');
            const ids = inputs.filter(ref => ref.kind === 'rest').map(ref => ref.serverMessageId);
            if (new Set(ids).size !== ids.length) reasons.push('duplicate-server-id');
            if (!inherited && batch && batch.inputCount !== inputs.length) reasons.push('input-count-mismatch');
            const value: InputEvidenceV1 = {
                v: 1, runtimeId: this.runtimeId, turnId: turn, batchId, rootBatchId: inherited?.rootBatchId ?? batchId,
                revision: 1, inputCount: inherited?.inputCount ?? batch?.inputCount ?? 0,
                inputs: structuredClone(inputs.filter(ref => inputRefSchema.safeParse(ref).success).slice(0, 256)),
                coverage: reasons.length ? 'incomplete' : 'complete', incompleteReasons: [...new Set(reasons)].slice(0, 32),
                additional: inherited ? structuredClone(inherited.additional) : { attempted: 0, accepted: 0, pending: 0, unknown: 0, items: [] },
                continuation: inherited ? { ...inherited.continuation, state: 'running', previousTurn: { runtimeId: inherited.runtimeId, turnId: inherited.turnId } }
                    : { kind: 'none', state: 'none', previousTurn: null, retryId: null, rootExclusive: null }, terminal: false,
            };
            this.fit(value);
            this.turns.set(turn, value);
            this.current = this.last = turn;
            while (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value!);
        }
        const value = this.turns.get(turn);
        if (!value) return envelope;
        if (ev.t === 'final-answer' && Buffer.byteLength(ev.text, 'utf8') > 65536) {
            this.incomplete('answer-too-large', turn);
            return createEnvelope('agent', { t: 'turn-input-evidence', inputEvidence: this.snapshot(turn)! }, { turn });
        }
        if (ev.t === 'turn-end') {
            value.terminal = value.continuation.state !== 'pending';
            if (value.continuation.state === 'running') value.continuation.state = 'completed';
            if (this.current === turn) this.current = null;
        }
        if (ev.t === 'turn-start' || ev.t === 'turn-end' || ev.t === 'final-answer') {
            if (ev.t !== 'turn-start') value.revision += 1;
            return { ...envelope, ev: { ...ev, inputEvidence: structuredClone(value) } };
        }
        return envelope;
    }
}
