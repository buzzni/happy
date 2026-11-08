/**
 * The terminal worker protocol (specs/terminal-survive-runner-restart HR5).
 *
 * Frozen envelope — never changes across protocol versions, so any daemon can close any worker:
 * the frame format (frames.ts), `hello` → `helloAck`, `request`/`response` with ops `list` and
 * `shutdown`, and the fields of their results below. Everything else is versioned: a daemon
 * adopts only a worker of its own `TERMINAL_WORKER_PROTOCOL_VERSION` and shuts down the rest.
 */

export const TERMINAL_WORKER_PROTOCOL_VERSION = 1

/** Test-only: the version a worker reports, so one build can stand up an incompatible worker. */
export const TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV = 'HAPPY_TERMINAL_WORKER_PROTOCOL_OVERRIDE'

/** The worker's identity marker in its own environment (spec HR10); never passed to shells. */
export const TERMINAL_WORKER_RECORD_ID_ENV = 'HAPPY_TERMINAL_WORKER_RECORD_ID'

export type WorkerProtocolFit = 'current' | 'incompatible'

/** No adapters: one released version, so anything else is closed, never adopted. */
export function classifyWorkerProtocol(reported: unknown, current: number = TERMINAL_WORKER_PROTOCOL_VERSION): WorkerProtocolFit {
    return reported === current ? 'current' : 'incompatible'
}

/** The protocol version this process speaks as a worker, honouring the test override. */
export function workerProtocolVersion(env: NodeJS.ProcessEnv = process.env): number {
    const override = Number(env[TERMINAL_WORKER_PROTOCOL_OVERRIDE_ENV])
    return Number.isSafeInteger(override) && override > 0 ? override : TERMINAL_WORKER_PROTOCOL_VERSION
}

// ── Frozen envelope ─────────────────────────────────────────────────────────

export interface WorkerHello {
    type: 'hello'
    secret: string
    protocolVersion: number
}

export interface WorkerHelloAck {
    type: 'helloAck'
    pid: number
    protocolVersion: number
    cliVersion: string
}

export interface WorkerRequest {
    type: 'request'
    requestId: string
    op: string
    args?: unknown
}

export type WorkerResponse =
    | { type: 'response'; requestId: string; ok: true; result?: unknown }
    | { type: 'response'; requestId: string; ok: false; error: string }

/** Frozen `list` result. */
export interface WorkerListResult {
    terminals: Array<{ id: string; pid: number; exited: boolean }>
}

// ── Version 1 ───────────────────────────────────────────────────────────────

/**
 * What the daemon needs to rebuild its registry entry after adopting a worker. Opaque to the
 * worker: it keeps and returns it. `binding` carries a v2 terminal's key material — the worker
 * holds it in memory only.
 */
export interface WorkerTerminalMeta {
    userId: string
    route: 'relay' | 'direct'
    machineId: string | null
    openedAt: number
    binding?: SerializedTerminalBinding
}

export interface SerializedTerminalBinding {
    terminalId: string
    terminalKey: string
    daemonNonce: string
    lastInSeq: number
}

export interface WorkerCreateArgs {
    id: string
    shell?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    cols?: number
    rows?: number
    meta: WorkerTerminalMeta
    bufferChars?: number
    bufferFrames?: number
}

/**
 * Version 1 ops beyond the frozen ones: `create` → WorkerCreateResult, `write {id,data}`,
 * `inject {id,data}` (daemon-made output, numbered with the shell's), `resize {id,cols,rows}`,
 * `signal {id,signal}`, `terminate {id,graceMs?}` → {outcome}, `dump {id}` → WorkerDumpResult,
 * `setMeta {id,meta}`, `forget {id}` (an ended terminal nobody needs).
 */
export interface WorkerCreateResult {
    pid: number
}

export interface WorkerDumpResult {
    id: string
    pid: number
    cols: number
    rows: number
    meta: WorkerTerminalMeta
    frames: Array<{ seq: number; chunk: string }>
    lastSeq: number
    exit: { code: number; signal: number | null } | null
}

export type WorkerEvent =
    | { type: 'event'; event: 'output'; id: string; seq: number; data: string }
    | { type: 'event'; event: 'exit'; id: string; code: number; signal: number | null }

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}
