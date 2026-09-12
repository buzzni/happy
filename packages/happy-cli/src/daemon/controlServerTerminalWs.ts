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
import { addDaemonTerminalSession, recordBytesIn, recordBytesOut, removeDaemonTerminalSession } from './daemonTerminalSessions';
import { createTerminalOutputCoalescer } from './terminalOutputCoalescer';

export interface TerminalWsRoute {
  wss: WebSocketServer;
  /** Closes the WS server and every open connection — plain `wss.close()`
   *  only stops accepting new ones and waits for existing sockets to close
   *  on their own, which would hang a test/shutdown with a client still open. */
  close: () => Promise<void>;
}

export interface MachineEncryption {
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function attachTerminalWsRoute(httpServer: HttpServer, opts: {
  path: string;
  controlSecret: string;
  allowedRoot: string;
  /** Null until the daemon's machine registration resolves — a connection
   *  attempted in that (brief, boot-time-only) window gets a clean error
   *  instead of crashing. */
  getMachineEncryption: () => MachineEncryption | null;
}): TerminalWsRoute {
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
  wss.on('connection', (ws) => {
    logger.debug('[CONTROL SERVER] /terminal WS connection opened');
    sockets.add(ws);

    // Set once `terminal-open` succeeds. A connection is one terminal, so
    // this pty reference is the entire per-connection state.
    let pty: PtySession | null = null;
    let sessionId: string | null = null;

    const send = (message: { reqId?: string; data?: unknown; error?: string }) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(message));
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
        if (pty !== null) return; // duplicate open on an already-open connection — ignore.

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

        const auditUserId = typeof openParams.userId === 'string' ? openParams.userId : 'local-direct-client';
        const cwdDecision = decideTerminalCwd({
          requested: typeof openParams.cwd === 'string' ? openParams.cwd : undefined,
          allowedRoot: opts.allowedRoot,
          homedir: homedir(),
          fsExists: existsSync,
          fsMkdir: (p) => mkdirSync(p, { recursive: true }),
          validate: validatePath,
        });

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

        sessionId = pty.id;
        const entry = addDaemonTerminalSession(sessionId, pty, { userId: auditUserId, machineId: null });

        const emitFrame = (chunk: string) => {
          try {
            const encoded = encodeBase64(encrypt(machineEncryption.encryptionKey, machineEncryption.encryptionVariant, chunk));
            send({ data: { event: 'terminal-frame', sessionId, data: encoded } });
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
          recordBytesOut(sessionId!, chunk.length);
          outputCoalescer.push(chunk);
        });
        pty.onExit((code, signal) => {
          outputCoalescer.flush();
          outputCoalescer.dispose();
          send({ data: { event: 'terminal-closed', sessionId, code, signal } });
          logger.debug(
            `[LOCAL-DIRECT-TERMINAL] close session=${sessionId} user=${entry.userId} exitCode=${code} signal=${signal ?? 'null'} ` +
            `bytesIn=${entry.bytesIn} bytesOut=${entry.bytesOut} durationMs=${Date.now() - entry.openedAt}`,
          );
          removeDaemonTerminalSession(sessionId!);
          pty = null;
        });

        logger.debug(`[LOCAL-DIRECT-TERMINAL] open session=${sessionId} user=${entry.userId} pid=${pty.pid}`);
        if (reqId) send({ reqId, data: { ok: true, sessionId, caps: { resume: false, snapshot: false, local: true } } });
        return;
      }

      if (pty === null || sessionId === null) return; // frame/resize/close before open — ignore.

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
        recordBytesIn(sessionId, chunk.length);
        pty.write(chunk);
        return;
      }

      if (event === 'terminal-resize') {
        if (!isRecord(data) || !Number.isInteger(data.cols) || !Number.isInteger(data.rows)) return;
        pty.resize(data.cols as number, data.rows as number);
        return;
      }

      if (event === 'terminal-close') {
        void pty.terminate();
        return;
      }
    });

    ws.on('close', () => {
      sockets.delete(ws);
      if (pty !== null) void pty.terminate();
    });
  });

  return {
    wss,
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        sockets.clear();
        wss.close(() => resolve());
      }),
  };
}
