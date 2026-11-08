/**
 * `/terminal` WebSocket route on the daemon control server (ADR-061,
 * specs/desktop-speed-breakthrough-local-direct T6+).
 *
 * A same-machine desktop app reaches the daemon's PTYs directly over loopback
 * instead of the saycode.ai relay. Auth happens at the WS upgrade — `ws`'s
 * `verifyClient` runs before the connection is accepted, so an unauthenticated
 * caller never gets a socket at all (not even one that immediately errors).
 *
 * One connection is one terminal (the desktop's `openDesktopRemoteTerminalSession`
 * opens a fresh socket per terminal on the relay path too — `session.ts`), so
 * there is no sessionId-based multiplexing to do within a connection.
 *
 * The terminal itself outlives its connection (specs/codexcli-daemon-stream-
 * durability B-R1, Phase B2a): output goes into the same seq'd replay buffer
 * the relay path uses, a dropped WebSocket leaves the PTY waiting for
 * DIRECT_TERMINAL_DETACH_GRACE_MS, and a new WebSocket takes it back with
 * `terminal-attach {sessionId, params}` — params sealed with the machine key
 * like `terminal-open`'s, naming the same session and user. Replay is the
 * client's `terminal-resume` afterwards, answered by terminalResumeReply.ts
 * exactly as on the relay path. An attach that does not match anything gets
 * `terminal-closed {reason:'unknown-session'}`, the same answer whatever the
 * reason, so it says nothing about which sessions exist.
 *
 * Wire envelope (T5, `controlWsEnvelope.ts`): `{reqId?, event, data}` in,
 * `{reqId, data}` / `{reqId, error}` out for anything the sender wants acked.
 * `terminal-open` is the only message the client sends with a `reqId` — frames/
 * resize/close are fire-and-forget on both sides, matching the relay protocol's
 * socket.io `emit` (not `emitWithAck`) shape (`src/remoteTerminal/transport.ts`).
 *
 * Frame encryption mirrors the relay path exactly (apiMachine.ts
 * `terminal-open-fwd`, ~line 2140): the machine's own `encryptionKey`/
 * `encryptionVariant`, via the same `encrypt`/`decrypt` dispatcher. Verified
 * (specs/desktop-speed-breakthrough-local-direct context.md 2026-09-04) that
 * this equals the desktop's `auth.secret`-derived key for `legacy`-variant
 * accounts — the only variant the desktop's remote-terminal code supports
 * today; `dataKey`-variant accounts already can't open a *relay* terminal
 * either, so this is an existing gap, not a regression introduced here.
 */

import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { logger } from '@/ui/logger';
import { decodeBase64, decrypt } from '@/api/encryption';
import { validatePath } from '@/modules/common/pathSecurity';
import { formatCwdFallbackBanner } from './decideTerminalCwd';
import { prepareTerminalOpen, type TerminalOpenAdmissionInput, type TerminalOpenPreparation } from './terminalOpenAdmission';
import { createPtySession, type PtySession } from './remoteTerminal';
import {
  addDaemonTerminalSession,
  markDaemonTerminalSessionExited,
  recordBytesIn,
  recordBytesOut,
  recordTerminalActivity,
  removeDaemonTerminalSession,
  type DaemonTerminalEntry,
} from './daemonTerminalSessions';
import { createTerminalOutputCoalescer } from './terminalOutputCoalescer';
import { replyToTerminalResume, resetPagedResume, sendExitAfterReplay } from './terminalResumeReply';
import { machineKeyTerminalCipher, type MachineEncryption } from './terminalCipher';
import { bindTerminal, createTerminalOpenNonceGuard, receiveBoundTerminalFrame, replyToBoundResume, restoreBoundTerminal } from './terminalBindingSession';
import type { AdoptedWorkerTerminal, TerminalWorkerHost } from './terminalWorker/workerHost';
import type { WorkerTerminalMeta } from './terminalWorker/protocol';
import { isWorkerPtySession } from './terminalWorker/workerPtySession';

export interface TerminalWsRoute {
  wss: WebSocketServer;
  /** Closes the WS server and every open connection — plain `wss.close()`
   *  only stops accepting new ones and waits for existing sockets to close
   *  on their own, which would hang a test/shutdown with a client still open.
   *  Also ends every terminal still waiting out its detach grace — except, when the terminal
   *  workers are keeping (aplus terminal-survive-runner-restart HR3), the worker terminals, which
   *  are let go of for the next daemon to adopt. */
  close: () => Promise<void>;
  /** Registers the direct terminals a starting daemon adopted from terminal workers (HR2). */
  adopt: (terminals: AdoptedWorkerTerminal[]) => void;
}

export type { MachineEncryption };

/**
 * What the route needs to know about the machine. `machineId` is the scope a bound open names and
 * `strict` refuses the v1 open (terminal-binding-strict-design §4-2); without an id no bound open
 * can match, so only the v1 open works there.
 */
export interface TerminalRouteMachine extends MachineEncryption {
  machineId?: string;
  strict?: boolean;
}

/**
 * How long a direct terminal survives with no WebSocket attached. Same value
 * as the relay's client re-attach window (happy-server terminalRelayHandler.ts
 * `CLIENT_REATTACH_GRACE_MS`) so both paths forgive the same drop; the two
 * packages share no module, so keep them equal by hand.
 */
export const DIRECT_TERMINAL_DETACH_GRACE_MS = 30_000;

/**
 * Open direct terminals per user, detached ones included — not ones that
 * ended or that the user closed, which only wait to report their exit. Same ceiling the
 * relay enforces (happy-server terminalSessions.ts `MAX_TERMINALS_PER_USER`)
 * and the same error text, so the desktop's capacity handling treats both
 * paths alike — and a refused direct open still falls back to the relay.
 */
export const MAX_DIRECT_TERMINALS_PER_USER = 5;

/** What the open ack and a successful attach advertise. */
const DIRECT_TERMINAL_CAPS = { resume: true, snapshot: true, local: true, attach: true, pagedResume: true } as const;

/**
 * A terminal in a terminal worker also says it outlives a daemon restart (aplus
 * terminal-survive-runner-restart HR4). Plaintext ack/attach caps only: the sealed v2 proof caps
 * are a strict schema on the client, so an extra key there would break every older app.
 */
function capsFor(pty: PtySession) {
  return isWorkerPtySession(pty) ? { ...DIRECT_TERMINAL_CAPS, survive: true } : DIRECT_TERMINAL_CAPS;
}

interface OpenParams {
  userId?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  shell?: string;
  args?: string[];
  env?: Record<string, string>;
}

interface AttachParams {
  sessionId?: unknown;
  afterSeq?: unknown;
  userId?: unknown;
}

/** One direct terminal, independent of whichever WebSocket currently carries it. */
interface DirectTerminal {
  readonly sessionId: string;
  readonly pty: PtySession;
  readonly entry: DaemonTerminalEntry;
  readonly userId: string;
  ws: WebSocket | null;
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** The user closed it: nobody re-attaches to it, so it waits out no grace window. */
  closing: boolean;
  /** Worker terminals only: what the worker keeps for the daemon that adopts it next. */
  meta?: WorkerTerminalMeta;
}

/** The registry entry holds the exit, as on the relay path (D4 B-R2). */
function exitOf(terminal: DirectTerminal) {
  return terminal.entry.exit;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The desktop sends `userId`; anything else is the anonymous local client, as before. */
function auditUserIdOf(params: { userId?: unknown }): string {
  return typeof params.userId === 'string' ? params.userId : 'local-direct-client';
}

export function attachTerminalWsRoute(httpServer: HttpServer, opts: {
  path: string;
  controlSecret: string;
  allowedRoot: string;
  /** aplus-dev-studio specs/approved-folder-roots — folders outside allowedRoot the machine owner approved. */
  approvedRoots?: () => readonly string[];
  /** Null until the daemon's machine registration resolves — a connection
   *  attempted in that (brief, boot-time-only) window gets a clean error
   *  instead of crashing. */
  getMachineEncryption: () => TerminalRouteMachine | null;
  /** Tests shorten this; production uses DIRECT_TERMINAL_DETACH_GRACE_MS. */
  detachGraceMs?: number;
  reserveLegacyDispatch?: TerminalOpenAdmissionInput['reserveLegacyDispatch'];
  admitSubprocess?: TerminalOpenAdmissionInput['admitSubprocess'];
  /** aplus terminal-survive-runner-restart: where new terminals open when workers are on. */
  terminalWorkers?: TerminalWorkerHost;
}): TerminalWsRoute {
  const detachGraceMs = opts.detachGraceMs ?? DIRECT_TERMINAL_DETACH_GRACE_MS;
  const wss = new WebSocketServer({
    server: httpServer,
    path: opts.path,
    verifyClient: (info, callback) => {
      // The desktop renderer's WebSocket is the standard browser API, which
      // cannot set an Authorization header on the upgrade request — a
      // `?token=` query param is the only channel it has. The header stays
      // for any future Node-side caller; either is sufficient.
      const headerToken = info.req.headers.authorization === `Bearer ${opts.controlSecret}`;
      const queryToken = new URL(info.req.url ?? '', 'http://localhost').searchParams.get('token') === opts.controlSecret;
      if (!headerToken && !queryToken) {
        callback(false, 401, 'Unauthorized');
        return;
      }
      callback(true);
    },
  });

  const sockets = new Set<WebSocket>();
  const terminals = new Map<string, DirectTerminal>();
  /** Opens past the per-user check that have not registered yet: a worker create is awaited. */
  const pendingOpens = new Map<string, number>();
  /** One recorded bound open opens one shell (terminalBindingSession.ts). */
  const terminalOpenNonceGuard = createTerminalOpenNonceGuard();

  const sendOn = (ws: WebSocket | null, message: { reqId?: string; data?: unknown; error?: string }) => {
    if (!ws || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(message));
  };

  /** Drops the terminal from every registry. The PTY is ended separately, if it still runs. */
  const forget = (terminal: DirectTerminal) => {
    if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
    terminal.graceTimer = null;
    if (terminals.get(terminal.sessionId) === terminal) terminals.delete(terminal.sessionId);
    removeDaemonTerminalSession(terminal.sessionId);
    // An ended worker terminal is kept by its worker for an adopting daemon; nobody needs it now.
    if (isWorkerPtySession(terminal.pty) && exitOf(terminal) !== null) terminal.pty.forget();
  };

  /** Tells the attached client the PTY ended, and drops the terminal. */
  const sendClosed = (terminal: DirectTerminal) => {
    const exit = exitOf(terminal);
    if (!exit) return;
    const reason = terminal.entry.closeReason;
    const binding = terminal.entry.binding;
    if (binding) {
      // The sealed close is the one a v2 client shows as the exit.
      const sealedReason = binding.closeReason ?? reason;
      sendOn(terminal.ws, { data: { event: 'terminal-frame', sessionId: terminal.sessionId, data: binding.sealOut({
        kind: 'closed', code: exit.code, signal: exit.signal, lastSeq: terminal.entry.output.lastSeq(), ...(sealedReason ? { reason: sealedReason } : {}),
      }) } });
    }
    sendOn(terminal.ws, { data: { event: 'terminal-closed', sessionId: terminal.sessionId, code: exit.code, signal: exit.signal, ...(reason ? { reason } : {}) } });
    forget(terminal);
  };

  /**
   * An ended PTY's exit goes out after the replay the client is reading, never
   * in the middle of it — the same rule as the relay path (terminalResumeReply.ts
   * `sendExitAfterReplay`). A held exit that comes due while the terminal is
   * detached is left to the grace window: the client that re-attaches resumes
   * into the output and the exit.
   */
  const sendClosedAfterReplay = (terminal: DirectTerminal) => {
    sendExitAfterReplay({
      output: terminal.entry.output,
      sendClosed: () => {
        if (terminals.get(terminal.sessionId) === terminal && terminal.ws !== null) sendClosed(terminal);
      },
    });
  };

  /** The WebSocket went away: keep the terminal for the grace window, then end it. */
  const detach = (terminal: DirectTerminal) => {
    terminal.ws = null;
    if (terminal.closing) {
      // Closed by the user, its PTY already ending: not a re-attach target.
      forget(terminal);
      return;
    }
    if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
    terminal.graceTimer = setTimeout(() => {
      terminal.graceTimer = null;
      if (terminal.ws !== null) return;
      logger.debug(`[LOCAL-DIRECT-TERMINAL] detach grace expired session=${terminal.sessionId} exited=${exitOf(terminal) !== null}`);
      forget(terminal);
      if (exitOf(terminal) === null) void terminal.pty.terminate();
    }, detachGraceMs);
    // A waiting terminal must not keep the daemon process alive on its own.
    terminal.graceTimer.unref?.();
    logger.debug(`[LOCAL-DIRECT-TERMINAL] detached session=${terminal.sessionId} — ${detachGraceMs}ms to re-attach`);
  };

  /** Sends one numbered output frame to whichever WebSocket carries the terminal now, if any. */
  const sendFrame = (terminal: DirectTerminal, seq: number, chunk: string) => {
    if (terminal.ws === null) return;
    const binding = terminal.entry.binding;
    try {
      if (binding) {
        // A v2 frame carries its seq sealed.
        sendOn(terminal.ws, { data: { event: 'terminal-frame', sessionId: terminal.sessionId, data: binding.sealOut({ kind: 'output', seq, data: chunk }) } });
        return;
      }
      const machineEncryption = opts.getMachineEncryption();
      if (!machineEncryption) return;
      sendOn(terminal.ws, { data: { event: 'terminal-frame', sessionId: terminal.sessionId, seq, data: machineKeyTerminalCipher(machineEncryption).seal(chunk) } });
    } catch (e) {
      logger.debug(`[CONTROL SERVER] /terminal frame encrypt failed: ${(e as Error).message}`);
    }
  };

  /**
   * Output and exit handling, the same for a terminal opened here and one adopted from a worker.
   * A worker numbers the output itself (its seq is what clients resume from, before and after a
   * restart); a terminal in this process is coalesced and numbered here, as before.
   */
  const wireTerminal = (terminal: DirectTerminal) => {
    const { sessionId, pty, entry } = terminal;
    let flushLocal: (() => void) | null = null;
    if (isWorkerPtySession(pty)) {
      pty.onOutput((seq, chunk) => {
        recordBytesOut(sessionId, chunk.length);
        if (entry.output.pushAt(seq, chunk) === seq) sendFrame(terminal, seq, chunk);
      });
    } else {
      // Buffer first, then send. Output while detached is buffered only, and
      // replayed when a client attaches and resumes.
      const outputCoalescer = createTerminalOutputCoalescer({
        sessionId,
        emit: (chunk) => sendFrame(terminal, entry.output.push(chunk), chunk),
      });
      pty.onData((chunk) => {
        recordBytesOut(sessionId, chunk.length);
        outputCoalescer.push(chunk);
      });
      flushLocal = () => {
        outputCoalescer.flush();
        outputCoalescer.dispose();
      };
    }
    pty.onExit((code, signal) => {
      flushLocal?.();
      // Kept in the registry, like a relay terminal, so a re-attaching
      // client resumes into the last output and this exit (D4 B-R2).
      if (!markDaemonTerminalSessionExited(sessionId, { code, signal })) {
        // A restart close (aplus codexcli-daemon-restart-drain R23) already took it
        // out of the registry; this terminal still answers its client's replay and
        // must say it ended.
        entry.exit = { code, signal };
      }
      // Audit every end, however it came about (exit, close, grace expiry, shutdown).
      logger.debug(
        `[LOCAL-DIRECT-TERMINAL] close session=${sessionId} user=${entry.userId} exitCode=${code} signal=${signal ?? 'null'} ` +
        `bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} durationMs=${Date.now() - entry.openedAt}`,
      );
      // Grace already expired: nobody is coming back for it.
      if (terminals.get(sessionId) !== terminal) {
        if (isWorkerPtySession(pty)) pty.forget();
        return;
      }
      if (terminal.closing) {
        // The user closed it: say so if still attached, and let it go.
        sendClosed(terminal);
        forget(terminal);
        return;
      }
      // Attached: say so (after any replay in flight). Detached: the
      // buffered output and the exit wait out the grace window for a
      // client that reattaches.
      if (terminal.ws !== null) sendClosedAfterReplay(terminal);
    });
  };

  wss.on('connection', (ws) => {
    logger.debug('[CONTROL SERVER] /terminal WS connection opened');
    sockets.add(ws);

    // The terminal this connection carries, once `terminal-open` or
    // `terminal-attach` succeeds. One per connection.
    let bound: DirectTerminal | null = null;
    let openingPending = false;

    const send = (message: { reqId?: string; data?: unknown; error?: string }) => sendOn(ws, message);

    const refuseAttach = (sessionId: unknown, reqId: string | undefined) => {
      // One answer whatever went wrong — unsealable params, another user,
      // an expired grace or an id that never existed — so an attach cannot
      // be used to learn which sessions exist.
      if (typeof sessionId === 'string') {
        send({ data: { event: 'terminal-closed', sessionId, reason: 'unknown-session' } });
      }
      if (reqId) send({ reqId, error: 'unknown-session' });
    };

    ws.on('message', (raw: RawData) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // not JSON — a stray/corrupt frame is dropped, not fatal to the connection.
      }
      if (!isRecord(msg) || typeof msg.event !== 'string') return;
      const { event, data, reqId } = msg as { event: string; data?: unknown; reqId?: string };

      if (event === 'terminal-open') {
        if (bound !== null) return; // duplicate open on an already-open connection — ignore.
        if (openingPending) {
          if (reqId) send({ reqId, error: 'Terminal opening is already pending' });
          return;
        }
        openingPending = true;
        void (async () => {
        let preparation: Extract<TerminalOpenPreparation, { kind: 'ready' }> | undefined;
        let reservedFor: string | null = null;
        try {

        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption) {
          if (reqId) send({ reqId, error: 'Daemon machine registration is not ready yet' });
          return;
        }
        if (!isRecord(data) || typeof data.params !== 'string') {
          if (reqId) send({ reqId, error: 'sessionId/params are required' });
          return;
        }

        let openParams: OpenParams | null = null;
        try {
          openParams = decrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, decodeBase64(data.params)) as OpenParams;
        } catch (e) {
          logger.debug(`[CONTROL SERVER] /terminal open decrypt failed: ${(e as Error).message}`);
        }
        if (!openParams) {
          if (reqId) send({ reqId, error: 'Failed to decrypt open params' });
          return;
        }
        const prepared = await prepareTerminalOpen({ opened: openParams,
          machineId: machineEncryption.machineId ?? '',
          strict: machineEncryption.strict === true,
          nonceGuard: terminalOpenNonceGuard,
          reserveLegacyDispatch: opts.reserveLegacyDispatch,
          admitSubprocess: opts.admitSubprocess,
          cwd: { allowedRoot: opts.allowedRoot, homedir: homedir(), fsExists: existsSync,
            fsMkdir: p => { mkdirSync(p, { recursive: true }); },
            validate: (path, root) => validatePath(path, root, opts.approvedRoots?.()) },
        });
        if (prepared.kind === 'refused') {
          logger.debug(`[CONTROL SERVER] /terminal open refused: ${prepared.code}`);
          if (reqId) send({ reqId, error: prepared.error });
          return;
        }
        preparation = prepared;
        if (ws.readyState !== ws.OPEN) return;
        if (bound !== null) {
          if (reqId) send({ reqId, error: 'Terminal connection is already attached' });
          return;
        }
        const { decision, cwdDecision } = prepared;
        openParams = decision.params as OpenParams;

        const auditUserId = auditUserIdOf(openParams);
        let open = pendingOpens.get(auditUserId) ?? 0;
        for (const terminal of terminals.values()) {
          if (terminal.userId === auditUserId && exitOf(terminal) === null && !terminal.closing) open += 1;
        }
        if (open >= MAX_DIRECT_TERMINALS_PER_USER) {
          if (reqId) send({ reqId, error: 'Too many active terminals' });
          return;
        }
        pendingOpens.set(auditUserId, (pendingOpens.get(auditUserId) ?? 0) + 1);
        reservedFor = auditUserId;
        // aplus terminal-survive-runner-restart: started (if need be) before the approval re-check,
        // so the create request leaves in the same turn as that check. No worker → opened here.
        const worker = opts.terminalWorkers?.enabled ? await opts.terminalWorkers.ensureWorker() : null;
        if (ws.readyState !== ws.OPEN) return;
        // A worker terminal gets its id here and a v2 one its binding with it, so the worker never
        // holds a v2 terminal without the key that guards it — not even for a moment before a crash.
        const workerSessionId = worker ? randomUUID() : null;
        const workerOpening = workerSessionId && decision.kind === 'bound'
          ? bindTerminal({ params: decision.params, nonce: decision.nonce, sessionId: workerSessionId, caps: { ...DIRECT_TERMINAL_CAPS } })
          : null;
        const meta: WorkerTerminalMeta = {
          userId: auditUserId, route: 'direct', machineId: null, openedAt: Date.now(),
          contract: decision.kind === 'bound' ? 'v2' : 'v1',
          ...(workerOpening ? { binding: workerOpening.terminal.exportState() } : {}),
        };
        await prepared.submit(async () => {
        let pty: PtySession;
        const ptyOptions = {
          userId: auditUserId,
          shell: typeof openParams.shell === 'string' ? openParams.shell : undefined,
          args: Array.isArray(openParams.args) ? openParams.args : undefined,
          cwd: cwdDecision.cwd,
          env: openParams.env && typeof openParams.env === 'object' ? openParams.env : undefined,
          cols: Number.isInteger(openParams.cols) ? openParams.cols : undefined,
          rows: Number.isInteger(openParams.rows) ? openParams.rows : undefined,
        };
        try {
          pty = worker && opts.terminalWorkers && workerSessionId
            ? await opts.terminalWorkers.createSession(worker, { ...ptyOptions, id: workerSessionId, meta })
            : createPtySession(ptyOptions);
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logger.debug(`[CONTROL SERVER] /terminal open spawn failed: ${message}`);
          if (reqId) send({ reqId, error: message });
          return;
        }
        // The worker's create was awaited: a connection that went meanwhile would leave a shell nobody detaches.
        if (ws.readyState !== ws.OPEN || bound !== null) {
          void pty.terminate().finally(() => { if (isWorkerPtySession(pty)) pty.forget(); });
          return;
        }

        const sessionId = pty.id;
        const entry = addDaemonTerminalSession(sessionId, pty, { userId: auditUserId, machineId: null, route: 'direct' });
        const opening = workerOpening ?? (decision.kind === 'bound'
          ? bindTerminal({ params: decision.params, nonce: decision.nonce, sessionId, caps: { ...DIRECT_TERMINAL_CAPS } })
          : null);
        if (opening) entry.binding = opening.terminal;
        const terminal: DirectTerminal = { sessionId, pty, entry, userId: auditUserId, ws, graceTimer: null, closing: false };
        terminals.set(sessionId, terminal);
        bound = terminal;
        if (isWorkerPtySession(pty)) terminal.meta = meta;
        wireTerminal(terminal);

        if (cwdDecision.fallback) {
          const banner = formatCwdFallbackBanner(cwdDecision);
          if (banner) {
            if (isWorkerPtySession(pty)) {
              pty.inject(banner);
            } else {
              sendFrame(terminal, entry.output.push(banner), banner);
              recordBytesOut(sessionId, banner.length);
            }
          }
          logger.debug(
            `[LOCAL-DIRECT-TERMINAL] cwd-fallback session=${sessionId} user=${entry.userId} ` +
            `requested=${cwdDecision.fallback.requested} fallback=${cwdDecision.cwd} reason=${cwdDecision.fallback.reason}`,
          );
        }

        logger.debug(`[LOCAL-DIRECT-TERMINAL] open session=${sessionId} user=${entry.userId} pid=${pty.pid}`);
        if (reqId) send({ reqId, data: { ok: true, sessionId, caps: opening
          ? { ...capsFor(pty), terminalBinding: { version: 1, proof: opening.proof } }
          : capsFor(pty) } });
        });
        } finally {
          if (reservedFor !== null) {
            const left = (pendingOpens.get(reservedFor) ?? 1) - 1;
            if (left > 0) pendingOpens.set(reservedFor, left);
            else pendingOpens.delete(reservedFor);
          }
          await preparation?.cancel();
          openingPending = false;
        }
        })().catch(error => {
          logger.debug(`[CONTROL SERVER] /terminal opening failed: ${error instanceof Error ? error.message : String(error)}`);
          if (reqId) send({ reqId, error: 'Terminal opening failed' });
        });
        return;
      }

      if (event === 'terminal-attach') {
        if (bound !== null) return; // this connection already carries a terminal.
        const sessionId = isRecord(data) ? data.sessionId : undefined;
        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption || typeof sessionId !== 'string' || !isRecord(data) || typeof data.params !== 'string') {
          refuseAttach(sessionId, reqId);
          return;
        }
        const boundTerminal = terminals.get(sessionId);
        const binding = boundTerminal?.entry.binding;
        if (boundTerminal && binding) {
          // terminal-binding-strict-design §4-6: a v2 terminal is taken back only with an attach
          // sealed with its in key and newer than anything it took — the machine key alone does not
          // reach it. A hole before it is a reconnect attempt that died with its socket (openAttach).
          const opened = binding.openAttach(data.params);
          const attach = opened.kind === 'frame' ? opened.frame : null;
          if (!attach) {
            logger.debug(`[LOCAL-DIRECT-TERMINAL] bound attach refused session=${sessionId} reason=${opened.kind}`);
            refuseAttach(sessionId, reqId);
            return;
          }
          const previous = boundTerminal.ws;
          boundTerminal.ws = ws;
          bound = boundTerminal;
          if (boundTerminal.graceTimer) clearTimeout(boundTerminal.graceTimer);
          boundTerminal.graceTimer = null;
          if (previous && previous !== ws) previous.close(4000, 'terminal attached elsewhere');
          resetPagedResume(boundTerminal.entry.output);
          recordTerminalActivity(sessionId);
          logger.debug(`[LOCAL-DIRECT-TERMINAL] bound attach session=${sessionId} exited=${exitOf(boundTerminal) !== null}`);
          if (reqId) send({ reqId, data: { ok: true, sessionId, caps: capsFor(boundTerminal.pty) } });
          // The attach names where its client stopped: the replay answers it right away.
          replyToBoundResume({
            sessionId,
            entry: boundTerminal.entry,
            binding,
            rid: attach.rid,
            afterSeq: attach.afterSeq,
            sendSealed: (sealed) => sendOn(ws, { data: { event: 'terminal-frame', sessionId, data: sealed } }),
            sendClosed: () => { if (boundTerminal.ws === ws) sendClosed(boundTerminal); },
          });
          return;
        }
        let params: AttachParams | null = null;
        try {
          params = decrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, decodeBase64(data.params)) as AttachParams;
        } catch {
          params = null;
        }
        const terminal = terminals.get(sessionId);
        if (!isRecord(params) || params.sessionId !== sessionId || !terminal || auditUserIdOf(params) !== terminal.userId) {
          logger.debug(`[LOCAL-DIRECT-TERMINAL] attach refused session=${sessionId}`);
          refuseAttach(sessionId, reqId);
          return;
        }

        // The newest attach wins: the old connection (a half-dead socket the
        // client already gave up on) loses the terminal and is closed.
        const previous = terminal.ws;
        terminal.ws = ws;
        bound = terminal;
        if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
        terminal.graceTimer = null;
        if (previous && previous !== ws) previous.close(4000, 'terminal attached elsewhere');
        // A paged replay in flight was going to the old connection.
        resetPagedResume(terminal.entry.output);
        recordTerminalActivity(sessionId);
        logger.debug(`[LOCAL-DIRECT-TERMINAL] attach session=${sessionId} user=${terminal.userId} exited=${exitOf(terminal) !== null}`);
        if (reqId) send({ reqId, data: { ok: true, sessionId, caps: capsFor(terminal.pty) } });
        return;
      }

      const terminal = bound;
      if (terminal === null || terminal.ws !== ws) return; // before open/attach, or taken over — ignore.

      const binding = terminal.entry.binding;
      if (binding) {
        // A v2 terminal takes its controls sealed; the plaintext resize and resume are not its client's.
        if (event === 'terminal-frame' && isRecord(data) && typeof data.data === 'string') {
          receiveBoundTerminalFrame({
            sessionId: terminal.sessionId,
            entry: terminal.entry,
            binding,
            data: data.data,
            sendSealed: (sealed) => send({ data: { event: 'terminal-frame', sessionId: terminal.sessionId, data: sealed } }),
            sendClosed: () => { if (terminal.ws === ws) sendClosed(terminal); },
            end: () => {
              terminal.closing = true;
              void terminal.pty.terminate();
            },
          });
        } else if (event === 'terminal-close' && exitOf(terminal) === null) {
          // Only the local app holds the control secret, so its plaintext close is its own.
          binding.closeReason ??= 'client-closed';
          terminal.closing = true;
          void terminal.pty.terminate();
        }
        return;
      }

      if (event === 'terminal-resume') {
        if (!isRecord(data)) return;
        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption) return;
        recordTerminalActivity(terminal.sessionId);
        try {
          // An ended terminal's exit rides the answer — after the last page
          // of output, by the rules the relay path follows too.
          replyToTerminalResume({
            sessionId: terminal.sessionId,
            output: terminal.entry.output,
            exit: exitOf(terminal),
            closeReason: terminal.entry.closeReason,
            afterSeq: data.afterSeq,
            maxChars: data.maxChars,
            seal: (chunk) => machineKeyTerminalCipher(machineEncryption).seal(chunk),
            emit: (replyEvent, payload) => {
              // A held exit can come due after this connection lost the terminal:
              // then the grace window or the newer connection owns it.
              if (replyEvent === 'terminal-closed' && terminal.ws !== ws) return;
              send({ data: { event: replyEvent, ...payload } });
              if (replyEvent === 'terminal-closed') forget(terminal);
            },
          });
        } catch (e) {
          logger.debug(`[LOCAL-DIRECT-TERMINAL] resume reply failed: ${(e as Error).message}`);
          return;
        }
        return;
      }

      if (exitOf(terminal) !== null) return; // the PTY is gone; only resume still means something.

      if (event === 'terminal-frame') {
        if (!isRecord(data) || typeof data.data !== 'string') return;
        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption) return;
        let chunk: string | null = null;
        try {
          chunk = machineKeyTerminalCipher(machineEncryption).open(data.data) as string | null;
        } catch {
          return;
        }
        if (typeof chunk !== 'string') return;
        recordBytesIn(terminal.sessionId, chunk.length);
        terminal.pty.write(chunk);
        return;
      }

      if (event === 'terminal-resize') {
        if (!isRecord(data) || !Number.isInteger(data.cols) || !Number.isInteger(data.rows)) return;
        terminal.pty.resize(data.cols as number, data.rows as number);
        return;
      }

      if (event === 'terminal-close') {
        terminal.closing = true;
        void terminal.pty.terminate();
        return;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      // Only the connection that currently carries the terminal detaches it;
      // one that was taken over by a newer attach has nothing left to drop.
      if (bound !== null && bound.ws === ws && terminals.get(bound.sessionId) === bound) detach(bound);
    });
  });

  /** Hands a worker terminal over to the next daemon: its latest binding state goes to the worker first. */
  const release = async (terminal: DirectTerminal) => {
    const pty = terminal.pty;
    if (!isWorkerPtySession(pty)) return;
    const binding = terminal.entry.binding;
    const meta = terminal.meta && binding ? { ...terminal.meta, binding: binding.exportState() } : terminal.meta;
    if (meta) await pty.setMeta(meta).catch((e) => logger.debug(`[LOCAL-DIRECT-TERMINAL] setMeta failed: ${(e as Error).message}`));
    pty.detach();
  };

  return {
    wss,
    close: async () => {
      const keeping = opts.terminalWorkers?.isKeeping() === true;
      const released: Promise<void>[] = [];
      for (const terminal of [...terminals.values()]) {
        const survives = keeping && isWorkerPtySession(terminal.pty) && exitOf(terminal) === null;
        if (survives) released.push(release(terminal));
        if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
        terminal.graceTimer = null;
        terminals.delete(terminal.sessionId);
        removeDaemonTerminalSession(terminal.sessionId);
        if (!survives && exitOf(terminal) === null) void terminal.pty.terminate();
      }
      if (released.length > 0) {
        await Promise.all(released);
        logger.debug(`[LOCAL-DIRECT-TERMINAL] left ${released.length} terminal(s) in their workers for the next daemon`);
      }
      for (const ws of sockets) ws.terminate();
      sockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
    adopt: (adopted) => {
      for (const { session, dump } of adopted) {
        if (dump.meta.route !== 'direct' || terminals.has(dump.id) || (dump.meta.contract === 'v2' && !dump.meta.binding)) {
          // Only direct terminals are kept for a restart; anything else has nobody to reconnect.
          void session.terminate().finally(() => session.forget());
          continue;
        }
        const entry = addDaemonTerminalSession(dump.id, session, { userId: dump.meta.userId, machineId: dump.meta.machineId, route: 'direct' });
        for (const frame of dump.frames) entry.output.pushAt(frame.seq, frame.chunk);
        if (dump.meta.binding) {
          try {
            entry.binding = restoreBoundTerminal({ sessionId: dump.id, state: dump.meta.binding });
          } catch (e) {
            logger.debug(`[LOCAL-DIRECT-TERMINAL] adopted binding unreadable session=${dump.id}: ${(e as Error).message}`);
            removeDaemonTerminalSession(dump.id);
            void session.terminate().finally(() => session.forget());
            continue;
          }
        }
        const terminal: DirectTerminal = { sessionId: dump.id, pty: session, entry, userId: dump.meta.userId, ws: null, graceTimer: null, closing: false, meta: dump.meta };
        terminals.set(dump.id, terminal);
        wireTerminal(terminal);
        // HR2: nobody is attached yet — the client has the detach grace, counted from now, to come back.
        detach(terminal);
        logger.debug(`[LOCAL-DIRECT-TERMINAL] adopted session=${dump.id} pid=${dump.pid} lastSeq=${dump.lastSeq} exited=${dump.exit !== null}`);
      }
    },
  };
}
