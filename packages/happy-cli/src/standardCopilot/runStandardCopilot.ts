/**
 * Runs Standard Copilot (Work IQ) as a Happy conversation session.
 */
import { randomUUID } from 'node:crypto';
import open from 'open';
import { createEnvelope, type SessionEnvelope } from '@slopus/happy-wire';
import { ApiClient } from '@/api/api';
import type { ApiSessionClient } from '@/api/apiSession';
import { encodeBase64 } from '@/api/encryption';
import type { AgentMessage } from '@/agent/core';
import { AcpSessionManager } from '@/agent/acp/AcpSessionManager';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { initialMachineMetadata } from '@/daemon/run';
import type { Credentials } from '@/persistence';
import { readSettings } from '@/persistence';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { createSessionMetadata } from '@/utils/createSessionMetadata';
import {
  consumePendingInitialPrompt,
  consumePendingInitialPromptLocalId,
} from '@/utils/initialPrompt';
import { setupOfflineReconnection } from '@/utils/setupOfflineReconnection';
import { connectionState } from '@/utils/serverConnectionErrors';
import { StandardCopilotBackend } from './StandardCopilotBackend';
import { createStandardCopilotTokenProvider, writePrivateAuthUrlHandoff } from './auth';
import {
  completeStandardCopilotTurn,
  StandardCopilotDocumentError,
} from './documentTurn';

export type RunStandardCopilotOptions = {
  credentials: Credentials;
  startedBy?: 'daemon' | 'terminal';
  verbose?: boolean;
};

export async function runStandardCopilot(options: RunStandardCopilotOptions): Promise<void> {
  const tenantId = process.env.WORKIQ_TENANT_ID?.trim() ?? '';
  const clientId = process.env.WORKIQ_CLIENT_ID?.trim() ?? '';
  const initialPrompt = consumePendingInitialPrompt(process.env);
  const initialPromptLocalId = consumePendingInitialPromptLocalId(process.env);
  const verbose = options.verbose === true;
  const log = (message: string) => {
    logger.debug(`[standard-copilot] ${message}`);
    if (verbose) console.log(`[standard-copilot] ${message}`);
  };
  const tokenProvider = createStandardCopilotTokenProvider({
    tenantId,
    clientId,
    openBrowser: async (url) => {
      const handoffFile = process.env.WORKIQ_AUTH_URL_FILE;
      if (handoffFile) {
        await writePrivateAuthUrlHandoff(handoffFile, url);
        log('Microsoft sign-in URL is ready for the configured browser handoff');
        return;
      }
      log('Opening Microsoft sign-in in the browser');
      await open(url);
    },
  });
  const backend = new StandardCopilotBackend({
    tokenProvider,
    onRequest: (event) => {
      const duration = event.durationMs === undefined ? '' : ` durationMs=${event.durationMs}`;
      const status = event.httpStatus === undefined ? '' : ` httpStatus=${event.httpStatus}`;
      log(`Work IQ request operation=${event.operation} state=${event.state}${status}${duration}`);
    },
  });
  const sessionTag = randomUUID();
  connectionState.setBackend('standard-copilot');

  const api = await ApiClient.create(options.credentials);
  const settings = await readSettings();
  if (!settings?.machineId) throw new Error('No machine ID found in settings');
  await api.getOrCreateMachine({ machineId: settings.machineId, metadata: initialMachineMetadata });

  const createdByAccountId = process.env.HAPPY_CREATED_BY_ACCOUNT_ID;
  const createdByDisplayName = process.env.HAPPY_CREATED_BY_DISPLAY_NAME;
  const { state, metadata } = createSessionMetadata({
    flavor: 'standard-copilot',
    machineId: settings.machineId,
    startedBy: options.startedBy,
    sandbox: settings.sandboxConfig,
    ...(createdByAccountId
      ? { createdBy: { accountId: createdByAccountId, displayName: createdByDisplayName } }
      : {}),
  });
  const response = await api.getOrCreateSession({ tag: sessionTag, metadata, state });
  if (response) log(`Happy Session ID: ${response.id}`);

  let session: ApiSessionClient;
  let onSessionArchived: (() => void) | undefined;
  const { session: initialSession, reconnectionHandle } = setupOfflineReconnection({
    api,
    sessionTag,
    metadata,
    state,
    response,
    onSessionSwap: (newSession) => {
      session = newSession;
      if (onSessionArchived) newSession.on('archived', onSessionArchived);
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
      logger.debug('[standard-copilot] Failed to report session to daemon:', error);
    }
  }

  const sessionManager = new AcpSessionManager();
  const messageQueue = new MessageQueue2<Record<string, never>>(() => '');
  if (initialPrompt) {
    session.sendSessionProtocolMessage(
      createEnvelope('user', { t: 'text', text: initialPrompt }),
      initialPromptLocalId,
    );
    messageQueue.unshiftIsolated(initialPrompt, {});
  }
  let shouldExit = false;
  let abortController = new AbortController();
  let backendSessionId: string | null = null;
  let inTurn = false;
  let thinking = false;

  const sendEnvelopes = (envelopes: SessionEnvelope[]) => {
    for (const envelope of envelopes) session.sendSessionProtocolMessage(envelope);
  };
  const onBackendMessage = (message: AgentMessage) => {
    if (message.type === 'status' && inTurn) {
      const nextThinking = message.status === 'running';
      if (thinking !== nextThinking) {
        thinking = nextThinking;
        session.keepAlive(thinking, 'remote');
      }
    }
    sendEnvelopes(sessionManager.mapMessage(message));
  };
  backend.onMessage(onBackendMessage);

  session.onUserMessage((message) => {
    if (message.content.text) messageQueue.push(message.content.text, {});
  });
  session.keepAlive(false, 'remote');
  const keepAliveInterval = setInterval(() => session.keepAlive(thinking, 'remote'), 2000);

  async function handleAbort() {
    if (backendSessionId) await backend.cancel(backendSessionId);
    inTurn = false;
    thinking = false;
    session.keepAlive(false, 'remote');
    abortController.abort();
    abortController = new AbortController();
  }
  session.rpcHandlerManager.registerHandler('abort', handleAbort);
  const handleKillSession = async () => {
    shouldExit = true;
    messageQueue.close();
    await handleAbort();
  };
  registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);
  onSessionArchived = () => {
    log('Session archived server-side, terminating');
    void handleKillSession();
  };
  session.on('archived', onSessionArchived);

  try {
    const started = await backend.startSession();
    backendSessionId = started.sessionId;
    log(`Work IQ conversation started: ${started.sessionId}`);
    session.sendSessionEvent({ type: 'ready' });

    while (!shouldExit) {
      const waitSignal = abortController.signal;
      const batch = await messageQueue.waitForMessagesAndGetAsString(waitSignal);
      if (!batch) {
        if (shouldExit) break;
        if (waitSignal.aborted) continue;
        break;
      }

      inTurn = true;
      sendEnvelopes(sessionManager.startTurn());
      try {
        log(`Sending Work IQ prompt (${batch.message.length} characters)`);
        const turn = await completeStandardCopilotTurn({
          userPrompt: batch.message,
          workspaceDirectory: process.cwd(),
          generateText: (providerPrompt) => backend.generateText(started.sessionId, providerPrompt),
        });
        log(
          `Work IQ turn completed kind=${turn.kind}`
          + ` promptCharacters=${turn.providerPromptCharacters}`
          + ` responseCharacters=${turn.providerResponseCharacters}`
          + (turn.format ? ` format=${turn.format}` : '')
          + (turn.artifactPath ? ` artifact=${turn.artifactPath}` : ''),
        );
        sendEnvelopes(sessionManager.mapMessage({
          type: 'model-output',
          textDelta: turn.text,
        }));
        sendEnvelopes(sessionManager.endTurn('completed'));
      } catch (error) {
        if (error instanceof StandardCopilotDocumentError) {
          sendEnvelopes(sessionManager.mapMessage({
            type: 'model-output',
            textDelta: error.message,
          }));
        }
        sendEnvelopes(sessionManager.endTurn('failed'));
        log(error instanceof Error ? error.message : 'Work IQ turn failed');
      } finally {
        inTurn = false;
        thinking = false;
        session.keepAlive(false, 'remote');
        session.sendSessionEvent({ type: 'ready' });
      }
    }
  } finally {
    clearInterval(keepAliveInterval);
    reconnectionHandle?.cancel();
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
      logger.debug('[standard-copilot] Session close failed:', error);
    }
  }
}
