/**
 * `/terminal` WebSocket route on the daemon control server (ADR-061,
 * specs/desktop-speed-breakthrough-local-direct T6+).
 *
 * A same-machine desktop app reaches the daemon's PTYs directly over loopback
 * instead of the saycode.ai relay. Auth happens at the WS upgrade — `ws`'s
 * `verifyClient` runs before the connection is accepted, so an unauthenticated
 * caller never gets a socket at all (not even one that immediately errors).
 *
 * T6 only wires the authenticated attach point; `terminal-open`/frame/resize/
 * close handling lands in T7-T9 on top of the same `connection` handler.
 */

import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '@/ui/logger';

export interface TerminalWsRoute {
  wss: WebSocketServer;
  /** Closes the WS server and every open connection — plain `wss.close()`
   *  only stops accepting new ones and waits for existing sockets to close
   *  on their own, which would hang a test/shutdown with a client still open. */
  close: () => Promise<void>;
}

export function attachTerminalWsRoute(httpServer: HttpServer, opts: {
  path: string;
  controlSecret: string;
}): TerminalWsRoute {
  const wss = new WebSocketServer({
    server: httpServer,
    path: opts.path,
    verifyClient: (info, callback) => {
      if (info.req.headers.authorization !== `Bearer ${opts.controlSecret}`) {
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
    ws.on('close', () => {
      sockets.delete(ws);
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
