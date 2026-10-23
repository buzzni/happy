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

import type { Server as HttpServer } from 'node:http';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { logger } from '@/ui/logger';
import { decodeBase64, encodeBase64, decrypt, encrypt } from '@/api/encryption';
import { validatePath } from '@/modules/common/pathSecurity';
import { decideTerminalCwd, formatCwdFallbackBanner } from './decideTerminalCwd';
import { createPtySession, type PtySession } from './remoteTerminal';
import {
  addDaemonTerminalSession,
  recordBytesIn,
  recordBytesOut,
  recordTerminalActivity,
  removeDaemonTerminalSession,
  type DaemonTerminalEntry,
} from './daemonTerminalSessions';
import { createTerminalOutputCoalescer } from './terminalOutputCoalescer';
import { PAGED_RESUME_STALE_MS, pagedReplayInFlight, replyToTerminalResume, resetPagedResume } from './terminalResumeReply';

export interface TerminalWsRoute {
  wss: WebSocketServer;
  /** Closes the WS server and every open connection — plain `wss.close()`
   *  only stops accepting new ones and waits for existing sockets to close
   *  on their own, which would hang a test/shutdown with a client still open.
   *  Also ends every terminal still waiting out its detach grace. */
  close: () => Promise<void>;
}

export interface MachineEncryption {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}

/**
 * How long a direct terminal survives with no WebSocket attached. Same value
 * as the relay's client re-attach window (happy-server terminalRelayHandler.ts
 * `CLIENT_REATTACH_GRACE_MS`) so both paths forgive the same drop; the two
 * packages share no module, so keep them equal by hand.
 */
export const DIRECT_TERMINAL_DETACH_GRACE_MS = 30_000;

/**
 * Open direct terminals per user, detached ones included. Same ceiling the
 * relay enforces (happy-server terminalSessions.ts `MAX_TERMINALS_PER_USER`)
 * and the same error text, so the desktop's capacity handling treats both
 * paths alike — and a refused direct open still falls back to the relay.
 */
export const MAX_DIRECT_TERMINALS_PER_USER = 5;

/** What the open ack and a successful attach advertise. */
const DIRECT_TERMINAL_CAPS = { resume: true, snapshot: true, local: true, attach: true, pagedResume: true } as const;

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
  exit: { code: number; signal: number | null } | null;
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
  /** Null until the daemon's machine registration resolves — a connection
   *  attempted in that (brief, boot-time-only) window gets a clean error
   *  instead of crashing. */
  getMachineEncryption: () => MachineEncryption | null;
  /** Tests shorten this; production uses DIRECT_TERMINAL_DETACH_GRACE_MS. */
  detachGraceMs?: number;
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
  };

  /** Tells the attached client the PTY ended, and drops the terminal. */
  const sendClosed = (terminal: DirectTerminal) => {
    const exit = terminal.exit;
    if (!exit) return;
    sendOn(terminal.ws, { data: { event: 'terminal-closed', sessionId: terminal.sessionId, code: exit.code, signal: exit.signal } });
    forget(terminal);
  };

  /**
   * An ended PTY's exit goes out after the replay the client is reading, never
   * in the middle of it — the client stops listening once it hears the
   * terminal closed, and the pages still to come hold its last output. If the
   * client stops asking for pages, the exit goes out once the replay goes stale.
   */
  const sendClosedAfterReplay = (terminal: DirectTerminal) => {
    if (!pagedReplayInFlight(terminal.entry.output)) {
      sendClosed(terminal);
      return;
    }
    if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
    terminal.graceTimer = setTimeout(() => {
      terminal.graceTimer = null;
      if (terminals.get(terminal.sessionId) === terminal) sendClosed(terminal);
    }, PAGED_RESUME_STALE_MS);
    terminal.graceTimer.unref?.();
  };

  /** The WebSocket went away: keep the terminal for the grace window, then end it. */
  const detach = (terminal: DirectTerminal) => {
    terminal.ws = null;
    if (terminal.graceTimer) clearTimeout(terminal.graceTimer);
    terminal.graceTimer = setTimeout(() => {
      terminal.graceTimer = null;
      if (terminal.ws !== null) return;
      logger.debug(`[LOCAL-DIRECT-TERMINAL] detach grace expired session=${terminal.sessionId} exited=${terminal.exit !== null}`);
      forget(terminal);
      if (terminal.exit === null) void terminal.pty.terminate();
    }, detachGraceMs);
    // A waiting terminal must not keep the daemon process alive on its own.
    terminal.graceTimer.unref?.();
    logger.debug(`[LOCAL-DIRECT-TERMINAL] detached session=${terminal.sessionId} — ${detachGraceMs}ms to re-attach`);
  };

  wss.on('connection', (ws) => {
    logger.debug('[CONTROL SERVER] /terminal WS connection opened');
    sockets.add(ws);

    // The terminal this connection carries, once `terminal-open` or
    // `terminal-attach` succeeds. One per connection.
    let bound: DirectTerminal | null = null;

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

        const auditUserId = auditUserIdOf(openParams);
        let open = 0;
        for (const terminal of terminals.values()) if (terminal.userId === auditUserId) open += 1;
        if (open >= MAX_DIRECT_TERMINALS_PER_USER) {
          if (reqId) send({ reqId, error: 'Too many active terminals' });
          return;
        }
        const cwdDecision = decideTerminalCwd({
          requested: typeof openParams.cwd === 'string' ? openParams.cwd : undefined,
          allowedRoot: opts.allowedRoot,
          homedir: homedir(),
          fsExists: existsSync,
          fsMkdir: (p) => mkdirSync(p, { recursive: true }),
          validate: validatePath,
        });

        let pty: PtySession;
        try {
          pty = createPtySession({
            userId: auditUserId,
            shell: typeof openParams.shell === 'string' ? openParams.shell : undefined,
            args: Array.isArray(openParams.args) ? openParams.args : undefined,
            cwd: cwdDecision.cwd,
            env: openParams.env && typeof openParams.env === 'object' ? openParams.env : undefined,
            cols: Number.isInteger(openParams.cols) ? openParams.cols : undefined,
            rows: Number.isInteger(openParams.rows) ? openParams.rows : undefined,
          });
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          logger.debug(`[CONTROL SERVER] /terminal open spawn failed: ${message}`);
          if (reqId) send({ reqId, error: message });
          return;
        }

        const sessionId = pty.id;
        const entry = addDaemonTerminalSession(sessionId, pty, { userId: auditUserId, machineId: null, route: 'direct' });
        const terminal: DirectTerminal = { sessionId, pty, entry, userId: auditUserId, ws, graceTimer: null, exit: null };
        terminals.set(sessionId, terminal);
        bound = terminal;

        // Buffer first, then send — to whichever WebSocket carries the
        // terminal now, if any. Output while detached is buffered only, and
        // replayed when a client attaches and resumes.
        const emitFrame = (chunk: string) => {
          const seq = entry.output.push(chunk);
          try {
            const encoded = encodeBase64(encrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, chunk));
            sendOn(terminal.ws, { data: { event: 'terminal-frame', sessionId, seq, data: encoded } });
          } catch (e) {
            logger.debug(`[CONTROL SERVER] /terminal frame encrypt failed: ${(e as Error).message}`);
          }
        };

        if (cwdDecision.fallback) {
          const banner = formatCwdFallbackBanner(cwdDecision);
          if (banner) {
            emitFrame(banner);
            recordBytesOut(sessionId, banner.length);
          }
          logger.debug(
            `[LOCAL-DIRECT-TERMINAL] cwd-fallback session=${sessionId} user=${entry.userId} ` +
            `requested=${cwdDecision.fallback.requested} fallback=${cwdDecision.cwd} reason=${cwdDecision.fallback.reason}`,
          );
        }

        const outputCoalescer = createTerminalOutputCoalescer({
          sessionId,
          emit: (chunk) => emitFrame(chunk),
        });
        pty.onData((chunk) => {
          recordBytesOut(sessionId, chunk.length);
          outputCoalescer.push(chunk);
        });
        pty.onExit((code, signal) => {
          outputCoalescer.flush();
          outputCoalescer.dispose();
          terminal.exit = { code, signal };
          // Audit every end, however it came about (exit, close, grace expiry, shutdown).
          logger.debug(
            `[LOCAL-DIRECT-TERMINAL] close session=${sessionId} user=${entry.userId} exitCode=${code} signal=${signal ?? 'null'} ` +
            `bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} durationMs=${Date.now() - entry.openedAt}`,
          );
          // Grace already expired: nobody is coming back for it.
          if (terminals.get(sessionId) !== terminal) return;
          // Attached: say so (after any replay in flight). Detached: the
          // buffered output and the exit wait out the grace window for a
          // client that reattaches.
          if (terminal.ws !== null) sendClosedAfterReplay(terminal);
        });

        logger.debug(`[LOCAL-DIRECT-TERMINAL] open session=${sessionId} user=${entry.userId} pid=${pty.pid}`);
        if (reqId) send({ reqId, data: { ok: true, sessionId, caps: DIRECT_TERMINAL_CAPS } });
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
        logger.debug(`[LOCAL-DIRECT-TERMINAL] attach session=${sessionId} user=${terminal.userId} exited=${terminal.exit !== null}`);
        if (reqId) send({ reqId, data: { ok: true, sessionId, caps: DIRECT_TERMINAL_CAPS } });
        return;
      }

      const terminal = bound;
      if (terminal === null || terminal.ws !== ws) return; // before open/attach, or taken over — ignore.

      if (event === 'terminal-resume') {
        if (!isRecord(data)) return;
        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption) return;
        recordTerminalActivity(terminal.sessionId);
        try {
          replyToTerminalResume({
            sessionId: terminal.sessionId,
            output: terminal.entry.output,
            afterSeq: data.afterSeq,
            maxChars: data.maxChars,
            seal: (chunk) => encodeBase64(encrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, chunk)),
            emit: (replyEvent, payload) => send({ data: { event: replyEvent, ...payload } }),
          });
        } catch (e) {
          logger.debug(`[LOCAL-DIRECT-TERMINAL] resume reply failed: ${(e as Error).message}`);
          return;
        }
        // An ended terminal reports its exit after the last page of output.
        if (terminal.exit !== null) sendClosedAfterReplay(terminal);
        return;
      }

      if (terminal.exit !== null) return; // the PTY is gone; only resume still means something.

      if (event === 'terminal-frame') {
        if (!isRecord(data) || typeof data.data !== 'string') return;
        const machineEncryption = opts.getMachineEncryption();
        if (!machineEncryption) return;
        let chunk: string | null = null;
        try {
          chunk = decrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, decodeBase64(data.data));
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

  return {
    wss,
    close: () =>
      new Promise((resolve) => {
        for (const terminal of [...terminals.values()]) {
          forget(terminal);
          if (terminal.exit === null) void terminal.pty.terminate();
        }
        for (const ws of sockets) ws.terminate();
        sockets.clear();
        wss.close(() => resolve());
      }),
  };
}
