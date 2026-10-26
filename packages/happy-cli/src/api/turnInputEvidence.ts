/** Runtime input witnesses. This is deliberately independent of AutomationTurnTracker's single-run arming. */
import { randomUUID } from 'node:crypto';
import { createEnvelope, hubPromptGuardSchema, inputRefSchema, type HubInputAdmissionV1,
    type InputEvidenceV1, type InputRef, type SessionEnvelope, type SessionTurnEndStatus } from '@slopus/happy-wire';

export type EvidenceBatch = { inputs: InputRef[]; inputCount: number; continuation?: InputEvidenceV1; incompleteReasons?: string[] };
type AdditionalKind = InputEvidenceV1['additional']['items'][number]['kind'];
type Attempt = InputEvidenceV1['additional']['items'][number];
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
    private readonly claimedContinuations = new WeakSet<InputEvidenceV1>();
    private background: EvidenceBatch | null = null;
    // Snapshot copies retain exact unresolved attempt identities, including items beyond the wire cap.
    // Weak keys do not keep discarded queue snapshots alive. Settled tokens are removed from live turns.
    private readonly attempts = new WeakMap<InputEvidenceV1, Set<Attempt>>();
    private readonly turns = new Map<string, InputEvidenceV1>();
    private current: string | null = null;
    private unmappedTurn: string | null = null;
    private last: string | null = null;
    private carry: InputEvidenceV1 | null = null;
    private readonly backgroundTurns = new Map<string, string>();
    rememberBackground(id: string, turn: string): void {
        this.backgroundTurns.set(id, turn);
        while (this.backgroundTurns.size > 200) this.backgroundTurns.delete(this.backgroundTurns.keys().next().value!);
    }
    rearmBackground(ids: string[], incompleteReasons: string[] = [], nextTurn = false): void {
        const turn = ids.map(id => this.backgroundTurns.get(id)).find(Boolean);
        for (const id of ids) this.backgroundTurns.delete(id);
        const source = turn ? this.snapshot(turn) : null;
        const unmapped = this.current !== null && this.current === this.unmappedTurn;
        if (unmapped) incompleteReasons = [...incompleteReasons, 'background-co-consumption'];
        const reasons = [...incompleteReasons, 'background-co-consumption', ...(!source ? ['background-source-unavailable'] : [])];
        // A consumed scanner row starts a new provider lifecycle even when the
        // routing mapper has no turn to close. Settle only our unmapped witness,
        // including its matching end for automation and other envelope consumers.
        if (nextTurn && this.unmappedTurn) {
            const previous = this.unmappedTurn;
            for (const reason of reasons) this.incomplete(reason, previous);
            const value = this.turns.get(previous);
            if (value) {
                value.terminal = true;
                if (value.continuation.state === 'pending' || value.continuation.state === 'running') value.continuation.state = 'cancelled';
                if (this.carry?.turnId === previous) this.carry = null;
                this.publish(value);
            }
            if (this.current === previous) this.current = null;
            this.unmappedTurn = null;
            this.emit(createEnvelope('agent', { t: 'turn-end', status: 'completed' }, { turn: previous }));
        }
        // Scanner consumption can close the previous mapper turn before its envelopes are stamped.
        // Its background observation belongs to the next turn, not that still-stamped current turn.
        if (this.current && !nextTurn) for (const reason of reasons) this.incomplete(reason, this.current);
        if (this.pending) this.pending.incompleteReasons = [...(this.pending.incompleteReasons ?? []), ...reasons];
        if ((this.current && !nextTurn && !unmapped) || this.pending) return;
        if (this.background) {
            this.background.incompleteReasons = [...(this.background.incompleteReasons ?? []), ...reasons];
            return;
        }
        if (!source) {
            this.background = { inputs: [], inputCount: 0, incompleteReasons: [...incompleteReasons, 'background-source-unavailable'] };
            return;
        }
        source.continuation = { kind: 'background', state: 'pending', retryId: null,
            previousTurn: { runtimeId: this.runtimeId, turnId: source.turnId },
            rootExclusive: source.inputCount === 1 && source.coverage === 'complete' && source.additional.attempted === 0
                && source.continuation.rootExclusive !== false };
        this.background = { inputs: [], inputCount: 0, continuation: source, incompleteReasons };
    }
    constructor(readonly runtimeId: string, private readonly emit: (envelope: SessionEnvelope) => void) {}
    currentTurn(): string | null { return this.current; }
    /** Textless dispatches need a witness, without opening or consuming a channel routing turn. */
    startUnmappedTurn(): SessionEnvelope[] {
        if (this.current || this.unmappedTurn) return [];
        this.unmappedTurn = randomUUID();
        return [createEnvelope('agent', { t: 'turn-start' }, { turn: this.unmappedTurn })];
    }
    unmappedFinalAnswer(text: string): SessionEnvelope[] {
        if (typeof text !== 'string' || !text.trim()) return [];
        const start = this.startUnmappedTurn();
        const turn = this.current ?? this.unmappedTurn!;
        return [...start, createEnvelope('agent', { t: 'final-answer', text }, { turn })];
    }
    closeUnmappedTurn(status: SessionTurnEndStatus): SessionEnvelope[] {
        return this.unmappedTurn ? [createEnvelope('agent', { t: 'turn-end', status }, { turn: this.unmappedTurn })] : [];
    }

    setPending(batch: EvidenceBatch | null): void {
        // Background observations survive replacement/cancellation of a batch that never dispatched.
        const reasons = (this.pending?.incompleteReasons ?? []).filter(reason => reason.startsWith('background-'));
        if (this.background) reasons.push('background-co-consumption', ...(this.background.incompleteReasons ?? []));
        if (batch && reasons.length) batch = { ...batch, incompleteReasons: [...(batch.incompleteReasons ?? []), ...reasons] };
        if (batch) this.background = null;
        else if (reasons.length && !this.background) this.background = { inputs: [], inputCount: 0, incompleteReasons: reasons };
        this.pending = batch;
    }
    /** Synchronous ownership transfer at the provider write; later input cannot cancel dispatched work. */
    commitPending(): boolean {
        if (!this.pending) return false;
        const continuation = this.pending.continuation;
        if (continuation && continuation.continuation.kind !== 'background') {
            const claimed = this.claimContinuation(continuation);
            if (!claimed) return false;
            this.pending.continuation = claimed;
        }
        return true;
    }
    /** Claim before provider dispatch; the receipt can wait in Claude's ordered transcript queue. */
    claimContinuation(value: InputEvidenceV1): InputEvidenceV1 | undefined {
        if (!this.isContinuationCurrent(value)) return undefined;
        const claimed = this.takeContinuation()!;
        this.claimedContinuations.add(claimed);
        this.carry = null;
        return claimed;
    }
    /** Called only when a claimed provider dispatch failed before any write was observed. */
    cancelPendingDispatch(): void {
        const claimed = this.pending?.continuation;
        if (!claimed || !this.claimedContinuations.delete(claimed)) return;
        const source = this.turns.get(claimed.turnId) ?? claimed;
        if (source.continuation.retryId !== claimed.continuation.retryId || source.continuation.state !== 'pending') return;
        source.continuation.state = 'cancelled';
        source.terminal = true;
        this.publish(source);
    }
    private clone(value: InputEvidenceV1): InputEvidenceV1 {
        const copy = structuredClone(value);
        this.attempts.set(copy, new Set(this.attempts.get(value)));
        return copy;
    }
    private settleAttempt(value: InputEvidenceV1, attempt: Attempt): void {
        if (!this.attempts.get(value)?.delete(attempt)) return;
        value.additional.pending -= 1;
        if (attempt.state === 'accepted' || attempt.state === 'unknown') value.additional[attempt.state] += 1;
        const item = value.additional.items.find(item => item.attemptId === attempt.attemptId);
        if (item) item.state = attempt.state;
    }
    snapshot(turn = this.current ?? this.last): InputEvidenceV1 | null {
        return turn && this.turns.has(turn) ? this.clone(this.turns.get(turn)!) : null;
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
        const attempts = this.attempts.get(value) ?? new Set<Attempt>();
        attempts.add(item);
        this.attempts.set(value, attempts);
        value.additional.pending += 1;
        if (value.additional.items.length < 128) value.additional.items.push(item);
        else this.incomplete('additional-limit', value.turnId);
        this.publish(value);
        let settled = false;
        return { settle: state => {
            if (settled) return;
            settled = true;
            item.state = state;
            for (const candidate of new Set([value, ...this.turns.values()])) {
                if (!this.attempts.get(candidate)?.has(item)) continue;
                this.settleAttempt(candidate, item);
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
        const result = this.clone(this.carry);
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
            const interleaved = this.unmappedTurn && this.unmappedTurn !== turn;
            if (interleaved) this.incomplete('witness-turn-interleaved', this.unmappedTurn);
            const batch = this.pending ?? this.background;
            const continuation = batch?.continuation;
            const validContinuation = continuation && (continuation.continuation.kind === 'background'
                || this.claimedContinuations.has(continuation) || this.isContinuationCurrent(continuation));
            const inherited = validContinuation
                ? (this.isContinuationCurrent(continuation) ? this.takeContinuation() : continuation) : undefined;
            this.pending = this.background = null;
            if (continuation) this.claimedContinuations.delete(continuation);
            if (inherited && this.carry?.continuation.retryId === inherited.continuation.retryId) this.carry = null;
            const batchId = randomUUID();
            const inputs = inherited?.inputs ?? batch?.inputs ?? [];
            const reasons = [...(inherited?.incompleteReasons ?? []), ...(batch?.incompleteReasons ?? [])];
            if (!batch) reasons.push('unobserved-input');
            if (interleaved) reasons.push('witness-turn-interleaved');
            if (continuation && !validContinuation) reasons.push('continuation-invalidated');
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
            this.attempts.set(value, new Set(inherited ? this.attempts.get(inherited) : undefined));
            // An ACK may settle after a snapshot was queued but before it starts.
            for (const attempt of this.attempts.get(value)!) if (attempt.state !== 'pending') this.settleAttempt(value, attempt);
            this.fit(value);
            this.turns.set(turn, value);
            this.current = this.last = turn;
            while (this.turns.size > 128) this.turns.delete(this.turns.keys().next().value!);
        }
        const value = this.turns.get(turn);
        if (!value) return envelope;
        if (ev.t === 'final-answer' && Buffer.byteLength(ev.text, 'utf8') > 65536) {
            // The downgrade is published as its own revision; the answer still goes out, unstamped.
            this.incomplete('answer-too-large', turn);
            return envelope;
        }
        if (ev.t === 'turn-end') {
            if (this.unmappedTurn === turn) this.unmappedTurn = null;
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
