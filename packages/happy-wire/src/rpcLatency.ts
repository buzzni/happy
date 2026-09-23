/** Opt-in, request-scoped diagnostics; never used for authorization or routing. */
export type RpcLatencyRequest = { version: 1; id: string };
export type RpcLatencyStage = 'server-managed-check' | 'server-lookup' | 'server-relay' | 'server-total'
    | 'daemon-decrypt' | 'daemon-handler' | 'daemon-encrypt' | 'daemon-total';
export type RpcLatencySpan = { stage: RpcLatencyStage; durationMs: number | null; outcome: 'pending' | 'resolved' | 'rejected'; lookupResult?: 'found' | 'empty' };
export type RpcLatencySnapshot = RpcLatencyRequest & { spans: RpcLatencySpan[]; droppedSpans: number; clockFailures: number };

export function parseRpcLatencyRequest(value: unknown): RpcLatencyRequest | undefined {
    if (!value || typeof value !== 'object') return;
    const { version, id } = value as Record<string, unknown>;
    if (version === 1 && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
        return { version: 1, id };
    }
    return undefined;
}

export function createRpcLatency(request: RpcLatencyRequest, now = () => performance.now()) {
    const spans: RpcLatencySpan[] = [];
    let droppedSpans = 0;
    let clockFailures = 0;
    const clock = () => {
        try { const n = now(); if (Number.isFinite(n)) return n; } catch { /* Timing cannot fail an RPC. */ }
        clockFailures++;
        return null;
    };
    const begin = (stage: RpcLatencyStage) => {
        if (spans.length >= 32) { droppedSpans++; return (_outcome: 'resolved' | 'rejected', _lookupResult?: 'found' | 'empty') => {}; }
        const start = clock();
        const span: RpcLatencySpan = { stage, durationMs: null, outcome: 'pending' };
        spans.push(span);
        return (outcome: 'resolved' | 'rejected', lookupResult?: 'found' | 'empty') => {
            if (span.outcome !== 'pending') return;
            const end = clock();
            span.durationMs = start === null || end === null ? null : Math.max(0, end - start);
            span.outcome = outcome;
            if (stage === 'server-lookup' && lookupResult) span.lookupResult = lookupResult;
        };
    };
    return {
        begin,
        async measure<T>(stage: RpcLatencyStage, operation: () => Promise<T>): Promise<T> {
            const end = begin(stage);
            try { const value = await operation(); end('resolved'); return value; }
            catch (error) { end('rejected'); throw error; }
        },
        measureSync<T>(stage: RpcLatencyStage, operation: () => T): T {
            const end = begin(stage);
            try { const value = operation(); end('resolved'); return value; }
            catch (error) { end('rejected'); throw error; }
        },
        snapshot(): RpcLatencySnapshot {
            return { ...request, spans: spans.map(s => ({ ...s })), droppedSpans, clockFailures };
        },
    };
}

/** Accept only fixed daemon stages; discard extra fields before returning to a caller. */
export function parseRpcLatencySnapshot(value: unknown, id: string): RpcLatencySnapshot | undefined {
    const request = parseRpcLatencyRequest(value);
    if (!request || request.id !== id) return undefined;
    const v = value as Record<string, unknown>;
    if (!Array.isArray(v.spans) || v.spans.length > 32) return undefined;
    if (![v.droppedSpans, v.clockFailures].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return undefined;
    const spans: RpcLatencySpan[] = [];
    for (const raw of v.spans) {
        if (!raw || typeof raw !== 'object') return undefined;
        const { stage, durationMs, outcome } = raw;
        if (!['daemon-total', 'daemon-decrypt', 'daemon-handler', 'daemon-encrypt'].includes(stage)) return undefined;
        if (!['pending', 'resolved', 'rejected'].includes(outcome)) return undefined;
        if (durationMs !== null && (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 600_000)) return undefined;
        spans.push({ stage, durationMs, outcome });
    }
    return { ...request, spans, droppedSpans: v.droppedSpans as number, clockFailures: v.clockFailures as number };
}
