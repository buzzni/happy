/**
 * OpenClaw Session Runner
 *
 * Entry point for OpenClaw agent sessions, following the runAcp.ts pattern.
 * The daemon spawns this as: `node dist/index.mjs openclaw --happy-starting-mode remote --started-by daemon`
 *
 * Connects to an OpenClaw gateway via WebSocket, translates the gateway protocol
 * to Happy's AgentMessage format, and forwards everything through the session pipeline.
 */

import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import type { SessionEnvelope } from '@slopus/happy-wire';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { createDeferredContinuationContextConsumer } from '@/utils/deferredContinuationContext';
import { Credentials, readSettings } from '@/persistence';
import { initialMachineMetadata } from '@/daemon/run';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { encodeBase64 } from '@/api/encryption';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { connectionState } from '@/utils/serverConnectionErrors';
import { OpenClawBackend } from './OpenClawBackend';
import type { OpenClawGatewayConfig } from './openclawTypes';
import type { AgentMessage, TurnInactivityWatchdog } from '@/agent/core';
import { startTurnInactivityWatchdog } from '@/agent/core';

/** Max time without any backend activity before the turn is cancelled. */
const TURN_INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

type PendingTurn = {
  resolve: () => void;
  reject: (err: Error) => void;
  watchdog: TurnInactivityWatchdog;
};

export interface RunOpenClawOptions {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  gatewayUrl?: string;
  gatewayToken?: string;
  gatewayPassword?: string;
  verbose?: boolean;
  /** Max time without any backend activity before the turn is cancelled. */
  turnInactivityTimeoutMs?: number;
}

/**
 * Query the openclaw CLI binary for a value. Returns trimmed stdout or null on failure.
 */
function openclawExec(...args: string[]): string | null {
  try {
    return execFileSync('openclaw', args, { timeout: 10_000, encoding: 'utf-8', windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/**
 * Get the gateway URL from the openclaw binary via `openclaw status --json`.
 * Falls back to constructing from config get gateway.port.
 */
function queryGatewayUrl(): string | null {
  const statusJson = openclawExec('status', '--json');
  if (statusJson) {
    try {
      const parsed = JSON.parse(statusJson);
      const url = parsed?.gateway?.url;
      if (typeof url === 'string' && url.length > 0) return url;
    } catch { /* fall through */ }
  }

  // Fallback: query port directly
  const port = openclawExec('config', 'get', 'gateway.port');
  if (port && /^\d+$/.test(port)) return `ws://127.0.0.1:${port}`;

  return null;
}

/**
 * Resolve the openclaw config file path.
 * Priority: OPENCLAW_CONFIG_PATH > OPENCLAW_STATE_DIR/openclaw.json > ~/.openclaw/openclaw.json
 */
function resolveConfigPath(): string {
  if (process.env.OPENCLAW_CONFIG_PATH) return process.env.OPENCLAW_CONFIG_PATH;
  const stateDir = process.env.OPENCLAW_STATE_DIR ?? join(os.homedir(), '.openclaw');
  return join(stateDir, 'openclaw.json');
}

/**
 * Get the gateway auth token by reading the openclaw config file directly.
 * The CLI redacts secrets so there's no way to query the token through the binary.
 */
function queryGatewayToken(): string | null {
  try {
    const raw = JSON.parse(readFileSync(resolveConfigPath(), 'utf-8'));
    const token = raw?.gateway?.auth?.token;
    return typeof token === 'string' ? token : null;
  } catch {
    return null;
  }
}

function resolveGatewayConfig(opts: RunOpenClawOptions): OpenClawGatewayConfig {
  // Priority: CLI args > env vars > openclaw binary auto-detection
  const url = opts.gatewayUrl
    ?? process.env.OPENCLAW_GATEWAY_URL
    ?? queryGatewayUrl();

  if (!url) {
    throw new Error(
      'OpenClaw gateway not found. Either:\n'
      + '  - Install and run openclaw locally\n'
      + '  - Set OPENCLAW_GATEWAY_URL env var\n'
      + '  - Pass --gateway-url',
    );
  }

  const token = opts.gatewayToken
    ?? process.env.OPENCLAW_GATEWAY_TOKEN
    ?? queryGatewayToken()
    ?? undefined;

  return {
    url,
    token,
    password: opts.gatewayPassword ?? process.env.OPENCLAW_GATEWAY_PASSWORD ?? undefined,
  };
}

export async function runOpenClaw(opts: RunOpenClawOptions): Promise<void> {
  const deferredContinuation = createDeferredContinuationContextConsumer(process.env);
  const verbose = opts.verbose === true;
  const turnInactivityTimeoutMs = opts.turnInactivityTimeoutMs ?? TURN_INACTIVITY_TIMEOUT_MS;
  const sessionTag = randomUUID();
  connectionState.setBackend('openclaw');

  const gatewayConfig = resolveGatewayConfig(opts);
  const log = (msg: string) => {
    logger.debug(`[openclaw] ${msg}`);
    if (verbose) {
      console.log(`[openclaw] ${msg}`);
    }
  };

  log(`Gateway URL: ${gatewayConfig.url}`);

  const api = await ApiClient.create(opts.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) {
    throw new Error('No machine ID found in settings');
  }

  await api.getOrCreateMachine({
    machineId: settings.machineId,
    metadata: initialMachineMetadata,
  });

  // Requester identity from the daemon's spawn RPC (specs/session-created-by).
  const createdByAccountId = process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
  const createdByDisplayName = process.env.HAPPY_CREATED_BY_DISPLAY_NAME;

  const { state, metadata } = createSessionMetadata({
    flavor: 'openclaw',
    machineId: settings.machineId,
    startedBy: opts.startedBy,
    ...(createdByAccountId ? { createdBy: { accountId: createdByAccountId, displayName: createdByDisplayName } } : {}),
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) {
    log(`Happy Session ID: ${response.id}`);
  }

  let session: ApiSessionClient;
  // Assigned after handleKillSession is defined; re-attached on session swap
  // so an offline-started session still exits when archived server-side.
  let onSessionArchived: (() => void) | undefined;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (onSessionArchived) {
        newSession.on('archived', onSessionArchived);
      }
    },
  });
  session = initialSession;

  if (response) {
    try {
      await notifyDaemonSessionStarted(response.id, metadata, {
        encryptionKey: encodeBase64(response.encryptionKey),
        encryptionVariant: response.encryptionVariant,
        seq: response.seq,
        metadataVersion: response.metadataVersion,
        agentStateVersion: response.agentStateVersion,
      });
    } catch (error) {
      logger.debug('[openclaw] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  let shouldExit = false;
  let abortController = new AbortController();
  let pendingTurn: PendingTurn | null = null;
  let thinking = false;
  let inTurn = false;
  let backendSessionId: string | null = null;

  const clearPendingTurn = (error?: Error) => {
    if (!pendingTurn) return;
    pendingTurn.watchdog.stop();
    const current = pendingTurn;
    pendingTurn = null;
    if (error) {
      current.reject(error);
    } else {
      current.resolve();
    }
  };

  // Bounds inactivity rather than total turn duration: backend progress restarts
  // the window, so a long turn that keeps reporting is never cut off. Cancel the
  // backend before giving up — rejecting alone would leave the agent running
  // while the runner reports the turn as failed.
  const waitForTurnEnd = () => {
    const turnEnded = new Promise<void>((resolve, reject) => {
      // A previous turn that was abandoned without clearing would otherwise leave
      // an armed watchdog behind that outlives the turn it belongs to.
      pendingTurn?.watchdog.stop();
      const watchdog = startTurnInactivityWatchdog({
        timeoutMs: turnInactivityTimeoutMs,
        onInactive: () => {
          log(`No backend activity for ${turnInactivityTimeoutMs}ms; cancelling turn`);
          if (backendSessionId) {
            void backend.cancel(backendSessionId).catch((error) => {
              logger.debug('[openclaw] Failed to cancel inactive turn:', error);
            });
          }
          clearPendingTurn(new Error(`OpenClaw produced no activity for ${turnInactivityTimeoutMs}ms`));
        },
      });
      pendingTurn = { resolve, reject, watchdog };
    });
    // When the gateway goes unresponsive, sendPrompt itself hangs and the loop
    // never reaches `await turnEnded` — so a rejection (watchdog, backend stop,
    // kill) lands on a promise with no handler attached. Mark it handled so it
    // fails the turn instead of crashing the process; `await turnEnded` still
    // observes it.
    turnEnded.catch(() => { });
    return turnEnded;
  };

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) {
      session.sendSessionProtocolMessage(envelope);
    }
  };

  const backend = new OpenClawBackend({
    homeDir: os.homedir(),
    gatewayConfig,
    log,
  });

  const onBackendMessage = (msg: AgentMessage) => {
    if (verbose) {
      log(`Backend message: ${JSON.stringify(msg).slice(0, 200)}`);
    }

    // Any backend message is proof the turn is still alive.
    pendingTurn?.watchdog.recordActivity();

    // Still forward all messages as envelopes so frontend history matches gateway,
    // but don't let stale post-abort events flip the thinking/turn state.
    if (msg.type === 'status' && inTurn) {
      const nextThinking = msg.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
      if (msg.status === 'idle') {
        clearPendingTurn();
      }
    }
    if (msg.type === 'status' && (msg.status === 'error' || msg.status === 'stopped')) {
      log(`Backend ${msg.status}: ${msg.detail ?? ''}`);
      shouldExit = true;
      messageQueue.close();
      clearPendingTurn(new Error(`OpenClaw backend ${msg.status}: ${msg.detail ?? ''}`));
    }

    if (msg.type === 'event' && msg.name === 'openclaw-pairing-required') {
      log(`Device pairing required. Approve device via: openclaw devices list`);
    }

    sendEnvelopes(sessionManager.mapMessage(msg));
  };

  backend.onMessage(onBackendMessage);

  session.onUserMessage((message) => {
    if (!message.content.text) return;
    const deferredTurn = deferredContinuation.prepare(message.content.text);
    try {
      messageQueue.push(deferredTurn?.text ?? message.content.text, {});
      deferredTurn?.commit();
    } catch (error) {
      deferredTurn?.rollback();
      throw error;
    }
  });
  session.keepAlive(thinking, 'remote');

  const keepAliveInterval = setInterval(() => {
    session.keepAlive(thinking, 'remote');
  }, 2000);

  async function handleAbort() {
    log('Abort requested');
    try {
      const sessionKey = backend['sessionKey'];
      if (sessionKey) {
        await backend.cancel(sessionKey);
      }
    } catch (error) {
      logger.debug('[openclaw] Abort failed:', error);
    }
    // End the turn — gateway may not send final/error after abort
    inTurn = false;
    thinking = false;
    session.keepAlive(false, 'remote');
    clearPendingTurn();
    abortController.abort();
    abortController = new AbortController();
  }

  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  session.rpcHandlerManager.registerHandler('openclaw-retry-pairing', async () => {
    backend.retryConnect();
  });
  const handleKillSession = async () => {
    shouldExit = true;
    messageQueue.close();
    clearPendingTurn(new Error('Session terminated'));
    await handleAbort();
  };
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

  // Exit when the session is archived/deleted server-side: the web archive
  // button (ephemeral with reason='archived') or a fatal 404 from the
  // message sync. Without this the syncs stop but the process lingers.
  // Also attached to swapped sessions via onSessionSwap (offline start).
  onSessionArchived = () => {
    log('Session archived server-side, terminating...');
    void handleKillSession();
  };
  session.on('archived', onSessionArchived);

  try {
    const started = await backend.startSession();
    backendSessionId = started.sessionId;
    log(`Connected. Session key: ${started.sessionId}`);

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      log(`Incoming prompt: ${batch.message.slice(0, 200)}`);
      inTurn = true;
      sendEnvelopes(sessionManager.startTurn());
      const turnEnded = waitForTurnEnd();
      try {
        await backend.sendPrompt(started.sessionId, batch.message);
        await turnEnded;
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log(`Turn ended: ${msg}`);
        // sendPrompt can throw before the turn is ever awaited (e.g. the gateway
        // dropped). Without this the watchdog stays armed on an abandoned turn and
        // later cancels whatever run is live by then. Resolve rather than reject:
        // nobody awaits this promise on the throw path.
        clearPendingTurn();
        sendEnvelopes(sessionManager.endTurn('failed'));
      }
      inTurn = false;
      thinking = false;
      session.keepAlive(false, 'remote');
      session.sendSessionEvent({ type: 'ready' });
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
    clearPendingTurn(new Error('OpenClaw runner shutting down'));

    backend.offMessage(onBackendMessage);
    await backend.dispose();

    try {
      session.updateMetadata((currentMetadata) => ({
        ...currentMetadata,
        lifecycleState: 'archived',
        lifecycleStateSince: Date.now(),
        archivedBy: 'cli',
        archiveReason: 'Session ended',
      }));
      session.sendSessionDeath();
      await session.flush();
      await session.close();
    } catch (error) {
      logger.debug('[openclaw] Session close failed:', error);
    }
  }
}
