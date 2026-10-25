import { MandatorySandboxError } from '@/sandbox/sandboxPolicy';
import { randomUUID } from "node:crypto";
import type { Metadata } from '@/api/types';
import { render } from "ink";
import { createManagedGracefulStop, registerManagedGracefulStop, type ManagedGracefulStop } from '@/managed/managedGracefulStop'
import { createProviderExitObserver, type ProviderExitObserver } from '@/managed/managedProviderExitObserver'
import { waitForObservedExit, MANAGED_REPORT_EXIT_BUDGET_MS } from '@/managed/managedProviderExitObserver'
import { reportManagedStopOutcome } from '@/managed/managedStartup'
import { createGenerationProofs, type GenerationProof } from '@/managed/managedGenerationProof'
import { MANAGED_STOP_CLEAN } from '@/managed/managedControlChannel'
import { Session } from "./session";
import { MessageBuffer } from "@/ui/ink/messageBuffer";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import React from "react";
import { claudeRemote, type ClaudeActiveInputSender, type ClaudeTurnLatencyInput } from "./claudeRemote";
import type { ClaudeAuthObservation, ObservedAiAuthSource } from "./aiAuthObservation";
import { ClaudeSideQuestionBridge, createSideQuestionRpcHandler } from "./claudeSideQuestion";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import type { QueueLatencyTrace } from "@/utils/MessageQueue2";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { EnhancedMode } from "./loop";
import { RawJSONLines } from "@/claude/types";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import { installChannelPermissionWiring } from '@/channel/channelPermissionWiring';
import {
    createOrderedTurnDispatcher,
    finalAnswerItem,
    pendingRequestItem,
    structuredOutputItem,
    turnEndItem,
    type ChannelTurnOrderingTarget,
} from '@/channel/channelTurnOrdering';
import { judgeStructuredOutput, type StructuredOutputResult } from '@/claude/structuredOutput';
import { getToolName } from "./utils/getToolName";
import { getAskUserQuestionToolCallIds } from "./utils/questionNotification";
import { cleanupStdinAfterInk } from "@/utils/terminalStdinCleanup";
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { createEnvelope, type McpRuntimeServerStatus } from '@slopus/happy-wire';
import type { McpRuntimeRecovery } from './mcpRuntimeRecovery';
import { registerMcpReconnectHandler } from './registerMcpReconnectHandler';
import { publishClaudePromptSuggestion } from './promptSuggestionMetadata';
import { createStreamDeltaRelay } from './streamDeltaRelay';
import { contextUsageSignalItem, withContextUsageSignals } from './claudeContextUsage';
import { describeCheckpointFailure } from '@/checkpoint/checkpointFailure';
import { claudeNotSignedInNotice, isClaudeTokenRefreshFailure, describeClaudeLaunchFailure } from './utils/launchFailureMessage';
import { buildMandatoryRemoteDenyRules, resolveClaudeRemoteSandbox } from '@/sandbox/claudeSdkSandbox';

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan';
    allowedTools?: string[];
}

import { createPersonalClaudeFallback, PersonalClaudeRecheckRequired, PERSONAL_RECHECK_NOTICE } from './personalClaudeFallback';
import { readPersonalClaudeCredential } from './personalClaudeCredential';
import { readSetupTokenResumeSelection, isMachineSetupTokenBinding } from '@/daemon/sessionEnv';
import { createLessonTurnObservations } from '@/memory/lessonTurnObservations';
import { createSetupTokenAccountSwitching, CONTINUE_PROMPT, RESUME_REBOUND_NOTICE } from './setupTokenAccountSwitching';
import { reportSetupTokenUsage, requestSetupTokenRebind, requestSetupTokenAvailability, returnFromPersonalClaude } from '@/daemon/controlClient';
import {
    CLAUDE_TRANSIENT_CONTINUE_PROMPT,
    CLAUDE_TRANSIENT_RETRY_DELAYS_MS,
    createClaudeTransientRetry,
} from './claudeTransientRetry';
import { SETUP_TOKEN_BINDING_ENV, SETUP_TOKEN_RESUME_REBOUND_ENV, sharedMachineSetupTokenAuthority } from '@/daemon/sessionEnv';

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    logger.debug('[claudeRemoteLauncher] Starting remote launcher');

    // Survives generation restarts within this session; see the call below.
    const lessonObservations = createLessonTurnObservations();

    // Check if we have a TTY for UI rendering
    const hasTTY = process.stdout.isTTY && process.stdin.isTTY;
    logger.debug(`[claudeRemoteLauncher] TTY available: ${hasTTY}`);

    // Configure terminal
    let messageBuffer = new MessageBuffer();
    let inkInstance: any = null;

    if (hasTTY) {
        console.clear();
        inkInstance = render(React.createElement(RemoteModeDisplay, {
            messageBuffer,
            logPath: process.env.DEBUG ? session.logPath : undefined,
            onExit: async () => {
                // Exit the entire client
                logger.debug('[remote]: Exiting client via Ctrl-C');
                if (!exitReason) {
                    exitReason = 'exit';
                }
                await abort();
            },
            onSwitchToLocal: () => {
                // Switch to local mode
                logger.debug('[remote]: Switching to local mode via double space');
                doSwitch();
            }
        }), {
            exitOnCtrlC: false,
            patchConsole: false
        });
    }

    if (hasTTY) {
        process.stdin.resume();
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(true);
        }
        process.stdin.setEncoding("utf8");
    }

    // Handle abort
    let exitReason: 'switch' | 'exit' | null = null;
    let abortController: AbortController | null = null;
    let launchFailure: string | null = null;
    let abortFuture: Future<void> | null = null;
    let activeInputSender: ClaudeActiveInputSender | null = null;

    /**
     * This generation's SDK exit observer, reachable from the abort path.
     *
     * The observer is per generation and lives inside the loop; an abort can
     * arrive from outside it, and a cancelled provider must never be able to
     * look like one that finished on its own.
     */
    /**
     * One provider generation's proof, held as a single record.
     *
     * The two halves have to belong to the same SDK process, so they live
     * together: the observer that watched it, and whether *its* input ended by
     * exhaustion. A record is installed as `current` only when a real process
     * is watched, so a loop turn that launches nothing can neither answer nor
     * be written into — there is no shared latch to guard.
     */
    const generationProofs = createGenerationProofs();
    const startedGeneration = (): GenerationProof | null => generationProofs.current();

    async function abort() {
        session.cancelLessonReview();
        // Stop means stop: a retry waiting to fire must not restart the work (and exit/switch end it too).
        transientRetry.cancel();
        personalFallback?.cancelPending();
        setupTokenSwitching?.cancelForStop();
        if (abortController && !abortController.signal.aborted) {
            /*
             * Recorded before the abort, not after. A provider that handles
             * the cancellation and exits 0 reports no signal, so the exit
             * alone reads exactly like a graceful end — the request is the
             * only thing that distinguishes them.
             */
            startedGeneration()?.observer.markForced();
            abortController.abort();
        }
        await abortFuture?.promise;
    }

    async function doAbort() {
        logger.debug('[remote]: doAbort');
        session.onAbort();
        personalFallback?.cancelPending();
        setupTokenSwitching?.cancelForStop();
        /*
         * Only a retry was waiting (specs/claude-transient-retry R5a): the stop ends the wait. The
         * provider is idle, so killing it would only restart it, and its failed turn is already closed.
         */
        if (transientRetry.cancel() && !session.thinking) {
            session.cancelLessonReview();
            return;
        }
        await abort();
    }

    async function doSwitch() {
        logger.debug('[remote]: doSwitch');
        if (!exitReason) {
            exitReason = 'switch';
        }
        await abort();
    }

    // When to abort
    session.client.rpcHandlerManager.registerHandler('abort', doAbort); // When abort clicked
    session.client.rpcHandlerManager.registerHandler('switch', doSwitch); // When switch clicked
    session.client.rpcHandlerManager.registerHandler('steer', async (params: Record<string, unknown>) => {
        if (session.managedRun) {
            // A managed run answers exactly the prompt its envelope was admitted
        // for. Steering and setting a goal are free-text instructions that
        // reach the provider outside that admission — steering is injected
        // into the turn already running, and a goal is carried into every turn
        // after it. Refused before the provider or the queue is touched;
        // clearing a goal removes an instruction rather than adding one, so it
        // stays. Permission answers are bound to a request this run is already
        // waiting on and are untouched.
            return { success: false, error: 'A managed run cannot be steered' };
        }
        const text = typeof params?.text === 'string' ? params.text : '';
        if (!text.trim()) {
            return { success: false, error: 'Steer text is required' };
        }
        // Steering is input: refused once a standalone drain froze the runtime, tracked while it runs.
        const gate = session.standaloneDrain?.gate;
        if (gate?.isClosed()) return { success: false, error: 'This session is shutting down' };
        const steer = async () => {
            if (!await activeInputSender?.(text)) {
                return { success: false, error: 'No active Claude turn' };
            }
            session.onActiveUserInputAccepted?.(text);
            return { success: true };
        };
        return gate ? gate.admit(steer) : steer();
    });
    // `/btw`: one answer from the live conversation, outside the transcript and the turn queue.
    const sideQuestion = new ClaudeSideQuestionBridge();
    session.client.rpcHandlerManager.registerHandler('side-question', createSideQuestionRpcHandler({
        bridge: sideQuestion,
        isManagedRun: () => session.managedRun === true,
        gate: () => session.standaloneDrain?.gate,
        reportUsage: (usage) => session.client.reportSideQuestionUsage(usage, aiAuthObservation?.current()),
        newRequestId: () => randomUUID(),
    }));
    // Removed catch-all stdin handler - now handled by RemoteModeDisplay keyboard handlers

    // Create permission handler
    const permissionHandler = new PermissionHandler(session);
    // The unattended wait reads this run's turn attendance (codexcli-approval-session-binding R10).
    permissionHandler.setAttendance(session.turnAttendance);
    session.policyApprover = permissionHandler;
    let mcpStatusReader: Pick<McpRuntimeRecovery, 'readStatuses'> | null = null;
    let mcpController: Pick<McpRuntimeRecovery, 'reconnectServer'> | null = null;
    registerMcpReconnectHandler(
        session.client.rpcHandlerManager,
        session.client.sessionId,
        () => mcpController,
        () => mcpStatusReader,
    );

    // Drop any permission requests left over in agent state from a
    // previous CLI process that died while a tool prompt was open. The
    // in-memory pendingRequests map is fresh and empty, but the server
    // still has `requests: { [id]: {...} }` and the app shows a spinner
    // + "Permission required" banner that no click can clear — the
    // previous process is gone and the new one has no record of the id.
    // reset() moves any stale entries to completedRequests with status
    // 'canceled' so the UI reflects what actually happened.
    permissionHandler.reset('Previous CLI process exited before responding', 'runtime-restart');

    // Token-level preview frames ride a separate volatile channel and never
    // enter the persisted message queue below.
    const streamRelay = createStreamDeltaRelay({
        emit: (frame) => session.client.sendStreamDelta(frame),
    });

    /*
     * Outgoing message queue. It also carries the channel turn markers — the correlation id, the
     * final candidate and the terminal — so all three land in the same order as the transcript
     * they belong to. See `createOrderedTurnDispatcher` for why each of them must not be called
     * directly from an SDK callback.
     */
    /*
     * The dispatcher target. Everything but the permission binding is the session client's own
     * method; the binding needs the handler too, so it is composed here rather than giving the
     * client a reference to the handler.
     */
    let bindChannelPermission: (
        permissionId: string, toolName: string, instanceSeq: number,
    ) => void = () => { };
    /*
     * The current run's observation of its Claude login, and what it said when each log message
     * arrived. Captured on arrival because the queue sends later — possibly after the run that
     * observed it is over — and a message must carry what its own run saw, not the next one's.
     */
    let aiAuthObservation: ClaudeAuthObservation | null = null;
    /*
     * Compiled once: the format is session-scoped (specs/claude-cli-benchmark-followups R2), so
     * every turn is judged against the same schema. Null for an ordinary session, which then emits
     * no structured-output events at all.
     */
    const judgeTurnStructuredOutput = session.outputFormat ? judgeStructuredOutput(session.outputFormat) : null;
    if (judgeTurnStructuredOutput) session.client.enableStructuredOutputVerdicts();
    const observedAiAuthByLogMessage = new WeakMap<object, ObservedAiAuthSource>();
    const orderingTarget: ChannelTurnOrderingTarget = {
        setPendingTurnRequestId: (requestId) => session.client.setPendingTurnRequestId(requestId),
        sendFinalAnswerForChannelTurn: (text) => session.client.sendFinalAnswerForChannelTurn(text),
        sendStructuredOutput: (envelope) => session.client.sendStructuredOutput(envelope),
        closeClaudeSessionTurn: (status) => session.client.closeClaudeSessionTurn(status),
        // The dispatcher carries ordinary log messages as `unknown` because it also carries the
        // markers; the client's own signature is the narrower one.
        sendClaudeSessionMessage: (logMessage) =>
            session.client.sendClaudeSessionMessage(
                logMessage as Parameters<typeof session.client.sendClaudeSessionMessage>[0],
                undefined,
                observedAiAuthByLogMessage.get(logMessage as object),
            ),
        // Late-bound: the queue needs the target, and the wiring needs the queue.
        bindChannelPermission: (permissionId, toolName, instanceSeq) =>
            bindChannelPermission(permissionId, toolName, instanceSeq),
    };
    // The context meter's init and compaction signals ride the queue too (Saycode
    // specs/desktop-chat-context-window-meter): it drops `system` log messages.
    const messageQueue = new OutgoingMessageQueue(withContextUsageSignals(
        createOrderedTurnDispatcher(orderingTarget),
        (signal) => session.client.noteContextUsageSignal(signal),
    ));

    /*
     * The prompt→turn binding and the sanitized observation. The ordering this depends on lives in
     * `channel/channelPermissionWiring.ts` so this launcher and its tests run the same code.
     */
    bindChannelPermission = installChannelPermissionWiring({
        queue: messageQueue,
        handler: permissionHandler,
        // Membership, not "what is current" — see `channel/channelPermissionWiring.ts`.
        turnContextFor: (toolCallId, apply) =>
            session.client.bindChannelPermissionWhenKnown(toolCallId, apply),
        publish: (event) => session.client.sendSessionProtocolMessage(createEnvelope('agent', event)),
    });

    // Create SDK to Log converter (pass responses from permissions)
    const sdkToLogConverter = new SDKToLogConverter({
        sessionId: session.sessionId || 'unknown',
        cwd: session.path,
        version: process.env.npm_package_version
    }, permissionHandler.getResponses());


    // Handle messages
    /**
     * Whether the most recent SDK result reported success.
     *
     * `onReady` fires on *any* result, and closed every turn as `completed` regardless. For a
     * channel request that is the difference between "here is your answer" and "this failed":
     * the terminal is what makes a candidate deliverable, so a failed run reported as completed
     * would relay whatever text happened to be standing (Saycode specs/desktop-messenger-channels).
     */
    let lastResultSucceeded = true;
    /** The drain reads it: after its interrupt Claude Code exits 1, which only an interrupted turn explains. */
    let lastResultInterrupted = false;
    /*
     * Saycode specs/claude-transient-retry — a turn a temporary API failure ended before it produced
     * anything is asked again after a short wait, unless the user acts first. Survives provider
     * restarts: a checkpoint-protected session ends its provider at every turn.
     */
    const transientRetry = createClaudeTransientRetry<{ mode: EnhancedMode; hash: string | null }>({
        delaysMs: CLAUDE_TRANSIENT_RETRY_DELAYS_MS,
        onState: (state) => {
            // A scheduled run's failed turn is not final while its retry waits (specs/_archive/automation-result-delivery).
            session.client.setTransientRetryPending(state !== null);
            session.client.updateAgentState((current) => ({ ...current, transientRetry: state }));
        },
    });
    /** Whether the last turn was a slash command: a note in its place would not re-run it. */
    let lastTurnCommand = false;
    const isCommandText = (content: unknown) => typeof content === 'string' && /^\/\S/.test(content.trimStart());
    let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();
    let notifiedQuestionToolCalls = new Set<string>();

    /*
     * Saycode specs/claude-setup-token-account-selection — a session bound to an organization
     * setup-token account moves off it once the provider reports it used up. The token is read when
     * a provider process starts, so a switch restarts the provider on the same conversation.
     * An unbound shared-PC session moves the same way, within the PC's own assignment
     * (Saycode specs/shared-pc-session-account-continuation).
     */
    const runningAuthority = () => process.env[SETUP_TOKEN_BINDING_ENV] ?? sharedMachineSetupTokenAuthority(process.env);
    const initialPersonalAuthority = (() => { try { return readSetupTokenResumeSelection({ [SETUP_TOKEN_BINDING_ENV]: process.env[SETUP_TOKEN_BINDING_ENV]! })?.binding } catch { return undefined } })();
    const personalFallback = initialPersonalAuthority && !isMachineSetupTokenBinding(initialPersonalAuthority) && !session.managedRun && !session.exitAfterFirstTurn ? createPersonalClaudeFallback({
        env: process.env, now: Date.now, binding: () => process.env[SETUP_TOKEN_BINDING_ENV], busy: () => session.thinking || lastTurnChannel,
        availability: (binding, consent) => requestSetupTokenAvailability(session.client.sessionId, binding, consent),
        personal: readPersonalClaudeCredential,
        rebind: binding => returnFromPersonalClaude(session.client.sessionId, binding),
        notify: message => session.client.sendSessionEvent({ type: 'message', message }),
    }) : null;
    session.client.rpcHandlerManager.registerHandler('personal-claude-fallback', async (params: { action?: unknown; accountRef?: unknown; nonce?: unknown; consentProof?: unknown }) => {
        if (!personalFallback) return { version: 1, supported: false };
        if (params.action === 'restore-organization') {
            const restored = await personalFallback.restoreOrganization();
            // Control requests must not reach an old SDK process that still holds the personal token.
            const deadline = Date.now() + 10_000;
            while (restored && providerStale() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
            return { version: 1, supported: true, restored: restored && !providerStale() };
        }
        if (params.action === 'accept') {
            if (typeof params.accountRef !== 'string' || typeof params.nonce !== 'string' || typeof params.consentProof !== 'string') throw new Error('CLAUDE_PERSONAL_CONSENT_REQUIRED');
            const continueRefusal = setupTokenSwitching?.hasAccountRefusal();
            await personalFallback.accept(params.accountRef, params.nonce, params.consentProof);
            setupTokenSwitching?.cancelForStop();
            // Explicit consent continues only a rate-limited failed request, never a successful/channel turn.
            if (!lastResultSucceeded && !lastTurnChannel && continueRefusal) continuation = lastTurnMode;
            return { version: 1, supported: true, accepted: true };
        }
        if (params.action !== 'status') throw new Error('CLAUDE_PERSONAL_FALLBACK_INVALID_ACTION');
        return { version: 1, supported: true, offer: await personalFallback.status() };
    });
    let providerCredentialGeneration = 0;
    const setupTokenSwitching = runningAuthority() ? createSetupTokenAccountSwitching({
        sessionId: () => session.client.sessionId ?? null,
        binding: () => personalFallback?.identity() ? undefined : providerBinding ?? runningAuthority(),
        report: reportSetupTokenUsage,
        rebind: requestSetupTokenRebind,
        applyEnvironment: (environment) => { for (const [key, value] of Object.entries(environment)) process.env[key] = value; },
        notify: (message) => session.client.sendSessionEvent({ type: 'message', message }),
        notifyState: (message, state) => session.client.sendSessionEvent({ type: 'message', message, setupTokenRotation: { version: 1, state } }),
    }) : null;
    // Saycode specs/managed-account-session-continuation — said once per move, not again when this process relaunches.
    if (process.env[SETUP_TOKEN_RESUME_REBOUND_ENV] === '1') {
        session.client.sendSessionEvent({ type: 'message', message: RESUME_REBOUND_NOTICE, setupTokenRotation: { version: 1, state: 'resume-rebound' } });
    }
    delete process.env[SETUP_TOKEN_RESUME_REBOUND_ENV];
    /** Whether this generation's provider process has started (its `system/init` arrived). */
    let providerRunning = false;
    /** The mode the last turn ran with, across provider restarts — the continuation of a refused turn reuses it. */
    let lastTurnMode: EnhancedMode | null = null;
    /** The setup-token binding (or shared-PC account) the running provider started with; usage is booked to it, not to a later switch. */
    let providerBinding: string | undefined;
    /** Whether the last turn answered a channel request; its lifecycle cannot authorize a second execution. */
    let lastTurnChannel = false;
    /** A refused turn to continue as the first turn of the next provider (set by a switch). */
    let continuation: EnhancedMode | null = null;
    /** The provider runs on a binding the session has since switched away from. */
    const providerStale = () => providerRunning && (providerCredentialGeneration !== (personalFallback?.generation() ?? 0) || providerBinding !== undefined && providerBinding !== runningAuthority());

    let backgroundTasks: NonNullable<Metadata['claudeBackgroundTasks']> | undefined;
    function publishBackgroundTasks(next: NonNullable<Metadata['claudeBackgroundTasks']>) {
        backgroundTasks = next;
        session.client.updateMetadata(current => ({ ...current, claudeBackgroundTasks: next }));
    }

    function onMessage(message: SDKMessage) {
        sideQuestion.noteMainMessage(message);
        transientRetry.observe(message);
        if (!personalFallback?.identity() && (message as { type?: unknown }).type === 'rate_limit_event') {
            setupTokenSwitching?.onRateLimitEvent((message as { rate_limit_info?: unknown }).rate_limit_info);
        }
        if (message.type === 'system' && message.subtype === 'init') {
            providerRunning = true;
            providerBinding = runningAuthority();
            providerCredentialGeneration = personalFallback?.generation() ?? 0;
            if (personalFallback && initialPersonalAuthority) session.client.setPersonalClaudeFallback({ companyId: initialPersonalAuthority.companyId,
                machineId: initialPersonalAuthority.machineId, generation: personalFallback.generation(), personal: personalFallback.identity() });
            session.client.setClaudeRuntimeAccount(process.env[SETUP_TOKEN_BINDING_ENV]);
            // The level signal is per provider process. Until its first full
            // snapshot, older CLIs still use this generation's transcript.
            publishBackgroundTasks({ startedAt: Date.now(), available: true, tasks: null });
        }
        if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
            publishBackgroundTasks({
                startedAt: backgroundTasks?.startedAt ?? Date.now(),
                available: true,
                // REPLACE, including empty: edge bookends can arrive out of
                // order and must never resurrect a task removed by this list.
                tasks: message.tasks.filter(task => !task.ambient).map(task => ({
                    taskId: task.task_id,
                    label: task.description,
                    kind: task.task_type.includes('bash') ? 'shell' : 'agent',
                })),
            });
            return;
        }


        // Write to message log
        formatClaudeMessageForInk(message, messageBuffer);

        // 턴 종료 result 는 transcript 로 가지 않는다 — 사용량 보정만 세션에 넘긴다
        // (Z.AI 호환 경로의 assistant usage 0 문제, src/usage/claudeTurnUsage.ts).
        if (message.type === 'result') {
            session.client.applyClaudeTurnResult(
                message as unknown as { uuid?: unknown; usage?: unknown; modelUsage?: unknown },
                aiAuthObservation?.current(),
            );
            /*
             * The SDK's own final answer (Saycode specs/desktop-messenger-channels — R14).
             *
             * `result` on a successful result message is the text Claude finished with, as the
             * provider reports it — not something inferred from the position of a tool call in
             * the transcript. It is published only when the open turn is answering a channel
             * request, and is still just a candidate: the matching `turn-end` with
             * `status: 'completed'` is what makes it deliverable.
             */
            const result = message as unknown as { subtype?: unknown; is_error?: unknown; result?: unknown };
            lastResultSucceeded = result.subtype === 'success' && result.is_error !== true;
            lastResultInterrupted = result.subtype === 'error_during_execution';
            const notSignedIn = claudeNotSignedInNotice(result);
            if (notSignedIn) session.client.sendSessionEvent({ type: 'message', message: notSignedIn });
            if (isClaudeTokenRefreshFailure(result)) {
                logger.warn(`[claude-auth] OAuth token refresh failed this turn (session process ${process.pid}); a retry may succeed. Concurrent refreshes or a locked keychain are the usual causes.`);
            }
            // Only a successful result carries an answer. A failed one must not leave an earlier
            // candidate standing either — the queue marker with an empty text clears it, and the
            // terminal that follows then reports no answer rather than an old one.
            if (result.subtype === 'success' && result.is_error !== true && typeof result.result === 'string') {
                messageQueue.enqueue(finalAnswerItem(result.result));
            }
            // Every turn gets a verdict, `missing` included; presence of a valid value decides it,
            // never `subtype` alone (an unsatisfiable schema ends `success` with no value).
            if (judgeTurnStructuredOutput) {
                messageQueue.enqueue(structuredOutputItem(judgeTurnStructuredOutput(result as StructuredOutputResult)));
            }
        }

        // Track active tool calls
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use') {
                        logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                        ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                    }
                }
            }
        }

        // Notify once when Claude asks the user a native clarifying question
        for (const toolCallId of getAskUserQuestionToolCallIds(message)) {
            if (notifiedQuestionToolCalls.has(toolCallId)) {
                continue;
            }
            notifiedQuestionToolCalls.add(toolCallId);
            // A managed run holds a scoped runner grant: there is no account
            // behind it, and `push()` refuses it — correctly, and that refusal
            // stays. This is an ordinary progress notification, so on a managed
            // run there is simply nobody to tell.
            if (!session.managedRun) session.api.push().sendSessionNotification({
                kind: 'question',
                metadata: session.client.getMetadata(),
                data: {
                    sessionId: session.client.sessionId,
                    tool: 'AskUserQuestion',
                    toolCallId,
                    type: 'question_request',
                    provider: 'claude',
                }
            });
        }

        if (message.type === 'user') {
            let umessage = message as SDKUserMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        ongoingToolCalls.delete(c.tool_use_id);

                        // When tool result received, release any delayed messages for this tool call
                        messageQueue.releaseToolCall(c.tool_use_id);
                    }
                }
            }
        }

        const contextUsageSignal = contextUsageSignalItem(message);
        if (contextUsageSignal) messageQueue.enqueue(contextUsageSignal);

        // Convert SDK message to log format and send to client
        const logMessage = sdkToLogConverter.convert(message);
        if (logMessage) {
            const observedAiAuth = aiAuthObservation?.current();
            if (observedAiAuth) observedAiAuthByLogMessage.set(logMessage, observedAiAuth);
            // Add permissions field to tool result content
            if (logMessage.type === 'user' && logMessage.message?.content) {
                const content = Array.isArray(logMessage.message.content)
                    ? logMessage.message.content
                    : [];

                // Modify the content array to add permissions to each tool_result
                for (let i = 0; i < content.length; i++) {
                    const c = content[i];
                    if (c.type === 'tool_result' && c.tool_use_id) {
                        const responses = permissionHandler.getResponses();
                        const response = responses.get(c.tool_use_id);

                        if (response) {
                            const permissions: PermissionsField = {
                                date: response.receivedAt || Date.now(),
                                result: response.approved ? 'approved' : 'denied'
                            };

                            // Add optional fields if they exist
                            if (response.mode) {
                                permissions.mode = response.mode;
                            }

                            if (response.allowTools && response.allowTools.length > 0) {
                                permissions.allowedTools = response.allowTools;
                            }

                            // Add permissions directly to the tool_result content object
                            content[i] = {
                                ...c,
                                permissions
                            };
                        }
                    }
                }
            }

            // Queue message with optional delay for tool calls
            if (logMessage.type === 'assistant' && message.type === 'assistant') {
                const assistantMsg = message as SDKAssistantMessage;
                const toolCallIds: string[] = [];

                if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                    for (const block of assistantMsg.message.content) {
                        if (block.type === 'tool_use' && block.id) {
                            toolCallIds.push(block.id);
                        }
                    }
                }

                if (toolCallIds.length > 0) {
                    // Check if this is a sidechain tool call (has parent_tool_use_id)
                    const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                    if (!isSidechain) {
                        // Top-level tool call - queue with delay
                        messageQueue.enqueue(logMessage, {
                            delay: 250,
                            toolCallIds
                        });
                        return; // Don't queue again below
                    }
                }
            }

            // Queue all other messages immediately (no delay)
            messageQueue.enqueue(logMessage);
        }

        // Insert a fake message to start the sidechain
        if (message.type === 'assistant') {
            let umessage = message as SDKAssistantMessage;
            if (umessage.message.content && Array.isArray(umessage.message.content)) {
                for (let c of umessage.message.content) {
                    if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                        const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                        if (logMessage2) {
                            messageQueue.enqueue(logMessage2);
                        }
                    }
                }
            }
        }
    }

    // Declared outside the `try` because the stop verdict is reported from
    // its `finally`, once the loop is really over.
    let gracefulStop: ManagedGracefulStop | null = null;
    try {
        let pending: {
            message: MessageParam['content'];
            mode: EnhancedMode;
            hash: string;
            /**
             * Kept on the held-back batch too. A message deferred because the mode
             * changed still has to commit its routing decision when the next
             * generation actually runs it — dropping the ids here would lose the
             * decision for exactly the turns that were queued behind a mode change.
             */
            requestIds?: string[];
            inputCount: number;
            latencyTraces: QueueLatencyTrace[];
            /** Carried through the deferral so an isolated channel turn keeps its handle. */
            channelRequestId?: string;
            /** Carried through the deferral so the turn is classified by its own inputs (R10a). */
            allUnattended?: boolean;
        } | null = null;
        /*
         * Queue time ends when a generation takes the batch. A batch held back
         * behind a provider restart is taken by the next generation, so it is
         * measured there — its restart cost belongs to its record.
         */
        const toTurnLatency = (batch: { inputCount: number; latencyTraces: QueueLatencyTrace[] }): ClaudeTurnLatencyInput | undefined => (
            batch.latencyTraces.length > 0
                ? {
                    attribution: batch.inputCount === 1 ? 'exclusive' : 'coalesced',
                    inputCount: batch.inputCount,
                    traces: batch.latencyTraces.map((trace) => ({
                        ...trace,
                        queueMs: Math.max(0, performance.now() - trace.receivedAt),
                    })),
                }
                : undefined
        );

        /**
         * Distinguishes one applied execution from the next, so a replayed or
         * duplicated boundary commits once. It counts *engine applications*, not
         * transport retries — a provider-level retry never re-enters this path.
         */

        /*
         * A managed run can be asked to end its input without being killed.
         *
         * Built here because it needs `pending`, which is what the message
         * loop holds back for the next turn and is invisible to the queue.
         * Only for managed runs: an ordinary session ends when its user says
         * so, and nothing else may end one on its behalf.
         */
        // A Windows standalone launch ends the same way when the daemon drains it (W0-5c).
        const drain = session.standaloneDrain;
        gracefulStop = session.managedRun || drain
            ? createManagedGracefulStop({
                queueSize: () => session.queue.size(),
                hasPending: () => pending !== null,
                // Wakes the `nextMessage()` that is waiting for input. The
                // queue is empty and nothing is pending, so this resolves the
                // waiter with `false` rather than delivering anything.
                wake: () => { session.queue.close(); },
            })
            : null;
        // Reachable from the control channel, which was read long before this
        // loop existed. A stop asked for in between is applied here.
        if (session.managedRun) registerManagedGracefulStop(gracefulStop);
        drain?.attachLauncher({
            requestEndInput: () => { gracefulStop?.request(); },
            cancelPendingPermissions: () => { permissionHandler.reset('Session is shutting down', 'shutdown'); },
            generation: () => startedGeneration()?.observer ?? null,
            hasHeldBackInput: () => pending !== null,
            lastResultInterrupted: () => lastResultInterrupted,
        });
        // A dispatched turn has no result yet: an earlier turn's interrupt must not answer for it.
        const dispatchTurn = () => { lastResultInterrupted = false; transientRetry.turnStarted(); drain?.dispatched(); };

        // Track session ID to detect when it actually changes
        // This prevents context loss when mode changes (permission mode, model, etc.)
        // without starting a new session. Only reset parent chain when session ID
        // actually changes (e.g., new session started or /clear command used).
        // See: https://github.com/anthropics/happy-cli/issues/143
        let previousSessionId: string | null = null;
        while (!exitReason) {
            logger.debug('[remote]: launch');
            // Per generation, not per session — see the note at the call.
            /*
             * A generation begins when the SDK actually spawns a process, not
             * when this loop comes round.
             *
             * A turn that returns `not-started` — an idle stop waking
             * `nextMessage`, for instance — launches no query at all. Swapping
             * in a fresh observer there would discard the previous
             * generation's real clean exit and report `provider-exit-unclean`
             * for a provider that had flushed and for a generation that never
             * existed. So both halves move together, and only when something
             * actually starts.
             */
            const proof = generationProofs.begin((onStarted) => (
                session.managedRun || drain ? createProviderExitObserver(onStarted) : null
            ));
            const sdkExit = proof?.observer ?? null;
            messageBuffer.addMessage('═'.repeat(40), 'status');

            // Only reset parent chain and show "new session" message when session ID actually changes
            const isNewSession = session.sessionId !== previousSessionId;
            if (isNewSession) {
                messageBuffer.addMessage('Starting new Claude session...', 'status');
                permissionHandler.reset(undefined, 'reset'); // Reset permissions before starting new session
                sdkToLogConverter.resetParentChain(); // Reset parent chain for new conversation
                logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
            } else {
                messageBuffer.addMessage('Continuing Claude session...', 'status');
                logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
            }

            previousSessionId = session.sessionId;
            const controller = new AbortController();
            abortController = controller;
            /** This generation's provider has ended; a wait it left behind must not take a due retry. */
            let providerEnded = false;
            abortFuture = new Future<void>();
            let modeHash: string | null = null;
            let mode: EnhancedMode | null = null;
            providerRunning = false;
            try {
                const remoteResult = await claudeRemote({
                    sessionId: session.sessionId,
                    lessonProposalTurn: session.lessonProposalTurn,
                    turnCards: session.turnCards,
                    lessonReviewLifecycle: session.lessonReviewLifecycle,
                    /*
                     * The host and completed-turn history belong to the session.
                     * The shared observation buffer is drained at every turn and
                     * generation boundary; interrupted work is never evidence
                     * for a later successful turn.
                     */
                    ...(session.lessons
                        ? {
                            lessons: {
                                turn: session.lessons.turn,
                                review: session.lessons.review,
                                sessionKind: session.lessons.sessionKind,
                                observations: lessonObservations,
                                /*
                                 * The authoritative Happy session id, not the
                                 * Claude provider one — that is null here on a
                                 * fresh session, and a placeholder would
                                 * attribute traces to an identity nobody can
                                 * resolve.
                                 */
                                sessionId: session.client.sessionId ?? null,
                            },
                        }
                        : {}),
                    path: session.path,
                    managedSettingsLockdown: session.managedSettingsLockdown || !!personalFallback?.identity(),
                    managedRun: session.managedRun,
                    /*
                     * A fresh observer for **this** generation.
                     *
                     * The observer keeps the first exit it sees, so one reused
                     * across generations would answer for a process that ended
                     * before this one started. A restart is a different
                     * process and gets a different observer.
                     */
                    ...(sdkExit ? { providerExitObserver: sdkExit } : {}),
                    /*
                     * `completeTurn` and `exitAfterFirstTurn` return without
                     * ever calling `nextMessage`, so the exhaustion they do
                     * reach has to be reported from there — otherwise a
                     * managed run in either mode can never be proven, however
                     * cleanly it ended.
                     */
                    onInputExhausted: () => { if (proof) proof.inputExhausted = true; },
                    allowedTools: session.allowedTools ?? [],
                    mcpServers: session.mcpServers,
                    mcpConfig: session.mcpConfig ? {
                        ...session.mcpConfig,
                        onApplied: (servers, aplusServers) => {
                            session.updateMcpConfiguration(servers, aplusServers);
                        },
                    } : undefined,
                    hookSettingsPath: session.hookSettingsPath,
                    offTurnTitle: session.offTurnTitle,
                    // SDK sandbox(주로 Bash 경계) 와 CLI 권한 규칙(도구 경계)을
                    // 함께 내려보낸다 — 한쪽만으로는 floor 가 반만 걸린다.
                    permissionsDeny: buildMandatoryRemoteDenyRules(
                        session.sandboxPolicyMode ?? 'owner-choice',
                    ),
                    scopeProcessSandbox: session.scopeProcessSandbox,
                    sandboxConfig: session.sandboxConfig,
                    sandboxPolicyMode: session.sandboxPolicyMode,
                    sandbox: resolveClaudeRemoteSandbox({
                        checkpointSandbox: session.checkpointComposition?.claudeSandbox,
                        sandboxConfig: session.sandboxConfig,
                        sessionPath: session.path,
                        policyMode: session.sandboxPolicyMode ?? 'owner-choice',
                    }),
                    beforeTurn: session.checkpointComposition?.beforeTurn
                        ?? session.checkpointComposition?.localHistory?.beforeTurn,
                    afterTurn: session.checkpointComposition?.localHistory?.afterTurn,
                    checkpointGuidance: session.checkpointComposition?.agentReader?.guidance,
                    prepareChannelExecution: session.prepareChannelExecution,
                    beginChannelExecution: session.beginChannelExecution,
                    completeTurn: session.checkpointComposition?.completeTurn,
                    jsRuntime: session.jsRuntime,
                    canCallTool: permissionHandler.handleToolCall,
                    isAborted: (toolCallId: string) => {
                        return permissionHandler.isAborted(toolCallId);
                    },
                    nextMessage: async () => {
                        if (mode) lastTurnMode = mode;
                        const accountSwitch = await setupTokenSwitching?.switchIfWanted();
                        if (accountSwitch?.switched && accountSwitch.continueAfter && !lastResultSucceeded && !lastTurnChannel && !controller.signal.aborted) {
                            continuation = mode ?? lastTurnMode;
                        }
                        // A running provider keeps the token it started with: end it, the loop resumes the conversation.
                        if (providerStale()) return null;
                        // The next provider's first turn: ahead of anything the user queued meanwhile, and alone.
                        if (!providerRunning && continuation) {
                            if (!pending && session.queue.size() === 0 && !session.queue.isClosed()) {
                                session.queue.unshiftIsolated(CONTINUE_PROMPT, continuation, undefined, session.turnAttendance?.continuationInput());
                            }
                            continuation = null;
                        }
                        if (pending) {
                            // A held-back batch is a turn like any other: refused once input is closed.
                            if (drain && !drain.claimTurn()) { exitReason = 'exit'; return null; }
                            let p = pending;
                            pending = null;
                            // This is the path an isolated channel turn actually takes: it was
                            // deferred when the previous query ended, and *this* is the moment it
                            // becomes the running turn.
                            messageQueue.enqueue(pendingRequestItem(p.channelRequestId ?? null));
                            session.turnAttendance?.startTurn({ allUnattended: p.allUnattended, channel: p.channelRequestId !== undefined });
                            lastTurnChannel = Boolean(p.channelRequestId);
                            lastTurnCommand = isCommandText(p.message);
                            transientRetry.userTurnStarted();
                            // This message starts the new provider. Seed its comparison
                            // baseline too, or the next model/effort change is missed.
                            modeHash = p.hash;
                            mode = p.mode;
                            permissionHandler.handleModeChange(p.mode.permissionMode);
                            /*
                             * The boundary may raise a decision that was queued
                             * before the floor rose. Applying the revision to
                             * the mode we are about to hand the SDK is the whole
                             * point: recording it while the turn still ran on
                             * the stale model would make the state a claim
                             * rather than a record of what executed.
                             */
                            const revisedPending = session.onModeApplied?.(p.requestIds, randomUUID());
                            if (revisedPending) {
                                const revisedMode: EnhancedMode = {
                                    ...p.mode,
                                    model: revisedPending.model,
                                    effort: (revisedPending.effort ?? undefined) as EnhancedMode['effort'],
                                };
                                mode = revisedMode;
                                p = { ...p, mode: revisedMode };
                            }
                            dispatchTurn();
                            return { ...p, latency: toTurnLatency(p) };
                        }

                        /*
                         * The turn boundary. A stop asked for mid-turn lands
                         * here, with the turn finished and nothing accepted
                         * after it.
                         *
                         * `exitReason` is set as well as returning `null`:
                         * `null` alone ends this provider's input, and the
                         * `while (!exitReason)` loop above would then launch a
                         * fresh one.
                         */
                        if (gracefulStop?.mayEndInput()) {
                            /*
                             * The only natural exhaustion. Recorded here and
                             * nowhere else: an abort also makes this function
                             * return `null`, and so does a mode change holding
                             * a message back, so the `null` itself proves
                             * nothing.
                             *
                             * And only for a generation that exists. This
                             * function is called for the *initial* message
                             * too, before any query spawns — so on an idle
                             * stop there is no SDK process at all, and marking
                             * exhaustion here would retroactively turn the
                             * previous generation's clean-but-unexhausted exit
                             * into a proof it never earned.
                             */
                            // Recorded on **this** generation's record. If it
                            // never started, nothing reads it.
                            if (proof) proof.inputExhausted = true;
                            exitReason = 'exit';
                            transientRetry.cancel();
                            return null;
                        }

                        /*
                         * Waits for the user and, alongside, for a retry to fall due
                         * (specs/claude-transient-retry). Whatever comes first wins: a
                         * queued message is collected before a due retry is looked at, so
                         * the two never both go out.
                         */
                        let msg: Awaited<ReturnType<typeof session.queue.waitForMessagesAndGetAsString>>;
                        while (true) {
                            const retryWake = transientRetry.waitSignal();
                            // A refused turn waiting for an organization account in the background
                            // (Saycode specs/claude-setup-token-managed-sync R7).
                            const switchWake = setupTokenSwitching?.backgroundSignal() ?? null;
                            const personalWake = personalFallback?.signal() ?? null;
                            const wakes = [retryWake, switchWake, personalWake].filter((signal): signal is AbortSignal => signal !== null);
                            msg = await session.queue.waitForMessagesAndGetAsString(
                                wakes.length ? AbortSignal.any([controller.signal, ...wakes]) : controller.signal,
                                drain ? () => drain.claimTurn() : undefined,
                            );
                            if (!msg && personalWake?.aborted && !controller.signal.aborted && providerStale()) return null;
                            if (!msg && switchWake?.aborted && !controller.signal.aborted) {
                                // A wait an ended provider left behind leaves the finished switch to the live generation.
                                if (providerEnded) return null;
                                // The switch finished while nobody typed: continue the refused turn on the new account,
                                // exactly like a switch made at the turn boundary.
                                const accountSwitch = await setupTokenSwitching!.switchIfWanted();
                                if (accountSwitch.switched && accountSwitch.continueAfter && !lastResultSucceeded && !lastTurnChannel) {
                                    continuation = mode ?? lastTurnMode;
                                }
                                if (providerStale()) return null;
                                if (!providerRunning && continuation) {
                                    if (!pending && session.queue.size() === 0 && !session.queue.isClosed()) {
                                        session.queue.unshiftIsolated(CONTINUE_PROMPT, continuation, undefined, session.turnAttendance?.continuationInput());
                                    }
                                    continuation = null;
                                }
                                continue;
                            }
                            // Anything but the retry's own wake (a closed queue, a refused claim, an
                            // abort) is handled below, as it would be without a retry waiting.
                            if (msg || !retryWake?.aborted || controller.signal.aborted) break;
                            // The next generation runs it.
                            if (providerEnded) return null;
                            const due = transientRetry.takeDue();
                            // Cancelled rather than due: keep waiting for the user.
                            if (!due) continue;
                            session.client.noteTransientRetryDispatched();
                            if (drain && !drain.claimTurn()) { exitReason = 'exit'; return null; }
                            messageQueue.enqueue(pendingRequestItem(null));
                            lastTurnChannel = false;
                            lastTurnCommand = false;
                            // The failed turn again keeps its attendance and its spent wait budget (R10a, Q6).
                            // The failed turn's own settings, unchanged — no provider restart.
                            mode = due.mode.mode;
                            modeHash = due.mode.hash ?? modeHash;
                            permissionHandler.handleModeChange(mode.permissionMode);
                            logger.debug(`[remote]: transient API failure retry ${due.attempt}`);
                            dispatchTurn();
                            return { message: CLAUDE_TRANSIENT_CONTINUE_PROMPT, mode };
                        }
                        // The user's own input replaces a waiting retry, and a background wait for an account.
                        if (msg) { transientRetry.userTurnStarted(); setupTokenSwitching?.userTurnStarted(); }
                        if (msg === null && gracefulStop?.requested() && !controller.signal.aborted) {
                            /*
                             * Woken by the stop rather than aborted — and the
                             * abort check is the whole point: a run that was
                             * aborted while a stop happened to be pending must
                             * not be recorded as having exhausted its input.
                             *
                             * Recorded on this generation's record. An idle
                             * wake before any query spawned has no record
                             * installed, so it ends the run without claiming
                             * an exhaustion the previous generation never had.
                             */
                            if (proof) proof.inputExhausted = true;
                            exitReason = 'exit';
                        }
                        // A kill seals the gate without requesting a stop; a batch it refused must
                        // end the loop, or every relaunch meets the same refusal and spins forever.
                        if (msg === null && drain?.gate.isClosed()) exitReason = 'exit';

                        // A switch that failed at the boundary is tried again before this message reaches the used-up
                        // account. The user's own message replaces the automatic continuation.
                        if (msg) await personalFallback?.beforeUserTurn();
                        if (msg?.channelRequestId && personalFallback?.identity()) throw new PersonalClaudeRecheckRequired();
                        if (msg && !personalFallback?.identity() && !providerStale()) await setupTokenSwitching?.switchIfWanted();
                        // A message that arrives after a switch (another boundary, or while it ran) belongs to the next provider.
                        if (msg && providerStale()) {
                            pending = msg;
                            drain?.releaseClaim();
                            return null;
                        }

                        // Check if mode has changed
                        if (msg) {
                            // Preview without committing: a changed engine setting needs a
                            // fresh SDK query before this request can be marked applied.
                            const resolved = session.onModeResolved?.(msg.requestIds);
                            if (resolved) {
                                msg = { ...msg, mode: { ...msg.mode, model: resolved.model,
                                    effort: (resolved.effort ?? undefined) as EnhancedMode['effort'] } };
                            }
                            const engineModeChanged = mode && (mode.model !== msg.mode.model || mode.effort !== msg.mode.effort);
                            if ((modeHash && msg.hash !== modeHash) || engineModeChanged || msg.isolate) {
                                logger.debug('[remote]: mode has changed, pending message');
                                pending = msg;
                                drain?.releaseClaim();
                                return null;
                            }
                            modeHash = msg.hash;
                            mode = msg.mode;
                            // The batch about to run is what answers the request, so the handle is
                            // attached here rather than where the message was queued: between those
                            // two points the queue may have reordered, isolated or dropped it.
                            // A batch with no channel message clears it, so an in-app turn never
                            // inherits an id.
                            messageQueue.enqueue(pendingRequestItem(msg.channelRequestId ?? null));
                            session.turnAttendance?.startTurn({ allUnattended: msg.allUnattended, channel: msg.channelRequestId !== undefined });
                            lastTurnChannel = Boolean(msg.channelRequestId);
                            lastTurnCommand = isCommandText(msg.message);
                            permissionHandler.handleModeChange(mode.permissionMode);
                            const latency = toTurnLatency(msg);

                            /*
                             * The engine-applied boundary for Claude. This batch's
                             * mode — model and effort included — is now the query's
                             * settings, so auto-routing may commit its floor here
                             * and nowhere earlier: everything before this point
                             * could still have been cancelled with the routed model
                             * never reaching the engine.
                             *
                             * This is not provider confirmation. It says the runner
                             * applied the setting, not that Anthropic served it.
                             *
                             * A batch whose mode differs returns above, so a message
                             * held back as `pending` is not committed here — it is
                             * committed by the generation that actually runs it.
                             */
                            const revisedBatch = session.onModeApplied?.(msg.requestIds, randomUUID());
                            if (revisedBatch) {
                                const revisedMode: EnhancedMode = {
                                    ...msg.mode,
                                    model: revisedBatch.model,
                                    effort: (revisedBatch.effort ?? undefined) as EnhancedMode['effort'],
                                };
                                mode = revisedMode;
                                msg = { ...msg, mode: revisedMode };
                            }

                            // Per-message attachments are already claimed by the message
                            // when it was pushed onto the queue, so there is no race window
                            // to wait out here — just consume what travelled with the batch.
                            const attachments = msg.attachments ?? [];
                            if (attachments.length > 0) {
                                const contentBlocks: ContentBlockParam[] = [];
                                for (const att of attachments) {
                                    // Detect media type from the decrypted bytes' magic header
                                    // rather than trusting the wire-supplied mimeType. iOS image
                                    // pickers happily report things like "image/heic" or no
                                    // mimeType at all, which the Anthropic API rejects with a
                                    // strict enum validation error. If the bytes look like one
                                    // of the four formats Claude accepts, send that label —
                                    // otherwise skip the attachment with a debug log.
                                    const detected = detectClaudeImageMime(att.data);
                                    if (!detected) {
                                        logger.debug(`[remote] Skipping unsupported attachment (no magic-byte match): ${att.name}, claimed mimeType=${att.mimeType}`);
                                        continue;
                                    }
                                    contentBlocks.push({
                                        type: 'image' as const,
                                        source: {
                                            type: 'base64' as const,
                                            media_type: detected,
                                            data: Buffer.from(att.data).toString('base64'),
                                        },
                                    });
                                }
                                contentBlocks.push({ type: 'text' as const, text: msg.message });
                                logger.debug(`[remote] Combined ${contentBlocks.length - 1} image(s) with text message`);
                                dispatchTurn();
                                return {
                                    message: contentBlocks,
                                    mode: msg.mode,
                                    latency,
                                    ...(msg.channelRequestId !== undefined ? { channelRequestId: msg.channelRequestId } : {}),
                                };
                            }

                            // Carried through so the slash-command parser in `claudeRemote` knows
                            // this text was relayed rather than typed into the app. A channel
                            // batch normally reaches that parser via the `pending` branch above,
                            // but the handle travels on every path so no future route drops it.
                            dispatchTurn();
                            return {
                                message: msg.message,
                                mode: msg.mode,
                                latency,
                                ...(msg.channelRequestId !== undefined ? { channelRequestId: msg.channelRequestId } : {}),
                            }
                        }

                        // Exit
                        return null;
                    },
                    onSessionFound: (sessionId) => {
                        // Update converter's session ID when new session is found
                        sdkToLogConverter.updateSessionId(sessionId);
                        session.onSessionFound(sessionId);
                        /*
                         * Onto **this** generation's record, captured in this
                         * iteration's closure — not `startedGeneration()`,
                         * which is whichever generation is current when the
                         * callback happens to run. The SDK reports a session
                         * asynchronously, so a slow callback from a finished
                         * generation can arrive after the next one began.
                         */
                        if (proof) proof.nativeId = sessionId;
                    },
                    onSDKMetadata: (metadata) => {
                        logger.debug('[remote] SDK metadata received, updating session:', metadata);
                        session.policyToolsSeen?.(metadata.tools ?? []);
                        session.client.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            tools: metadata.tools,
                            slashCommands: metadata.slashCommands,
                            mcpServers: metadata.mcpServers,
                            skills: metadata.skills,
                            plugins: metadata.plugins,
                        }));
                    },
                    onPromptSuggestionChange: (suggestion) => {
                        publishClaudePromptSuggestion(
                            session.client.updateMetadata.bind(session.client),
                            suggestion,
                        );
                    },
                    onQueryReady: (q) => {
                        drain?.setQuery({ interrupt: q.interrupt });
                        permissionHandler.setPermissionModeUpdater(async (mode) => {
                            await q.setPermissionMode(mode);
                        });
                    },
                    onMcpStatusReaderReady: (reader) => { mcpStatusReader = reader; },
                    onMcpControllerReady: (controller) => {
                        mcpController = controller;
                    },
                    onActiveInputReady: (sender) => {
                        activeInputSender = sender;
                    },
                    onSideQuestionChannelReady: (channel) => {
                        if (channel) sideQuestion.provide(channel); else sideQuestion.clear();
                    },
                    onMcpStatus: (status: McpRuntimeServerStatus) => {
                        session.client.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            mcpServers: [
                                ...(currentMetadata.mcpServers ?? []).filter((server) => server.name !== status.name),
                                status,
                            ],
                        }));
                    },
                    onThinkingChange: session.onThinkingChange,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    onMessage,
                    onAiAuthObservationReady: (observation) => { aiAuthObservation = observation; },
                    onStreamEvent: (message) => {
                        transientRetry.observe(message);
                        streamRelay.handleStreamEvent(message);
                    },
                    onTurnLatency: (diagnostic) => session.client.sendTurnLatency(diagnostic),
                    onCompletionEvent: (message: string) => {
                        logger.debug(`[remote]: Completion event: ${message}`);
                        session.client.sendSessionEvent({ type: 'message', message });
                    },
                    onSessionReset: () => {
                        logger.debug('[remote]: Session reset');
                        session.clearSessionId();
                        session.client.resetContextUsage();
                        session.onSessionReset?.();
                    },
                    onReady: () => {
                        drain?.turnEnded();
                        // Nothing waiting: a scheduled prompt that arrives next is the next turn (specs/_archive/automation-result-delivery).
                        if (!pending && session.queue.size() === 0) session.client.noteInputQueueEmpty?.();
                        // Queued, not called: a terminal emitted ahead of the transcript closes a
                        // turn that has not received its text yet, and the later flush opens a
                        // second, unrelated one.
                        messageQueue.enqueue(turnEndItem(lastResultSucceeded ? 'completed' : 'failed'));
                        const turnMode = mode ?? lastTurnMode;
                        // Channel requests are terminal after their turn; a managed or run-once turn
                        // answers only its admitted prompt; a note in its place cannot re-run a command.
                        // Input already waiting replaces it, so it is not announced at all.
                        const retry = transientRetry.afterTurn(turnMode && !lastTurnChannel && !lastTurnCommand
                            && !session.managedRun && !session.exitAfterFirstTurn && !controller.signal.aborted
                            && !pending && session.queue.size() === 0 && !gracefulStop?.requested()
                            ? { mode: turnMode, hash: modeHash } : null);
                        if (retry) {
                            const notice = retry.kind === 'scheduled'
                                ? `Temporary API error${retry.state.status === null ? '' : ` (${retry.state.status})`} — retrying automatically in ${Math.round((retry.state.retryAt - retry.state.scheduledAt) / 1000)}s (${retry.state.attempt}/${retry.state.maxAttempts}). Send a message or stop to cancel.`
                                : `Automatic retry gave up after ${retry.maxAttempts} attempts — the API is still unavailable.`;
                            messageBuffer.addMessage(notice, 'status');
                            session.client.sendSessionEvent({ type: 'message', message: notice });
                        }
                        // Not done while a retry waits: the turn will be answered after all.
                        if (retry?.kind !== 'scheduled' && !pending && session.queue.size() === 0) {
                            // Same reason as the question notification above.
                            // This one matters more: `onReady` fires on ANY SDK
                            // result and fires *after* the turn finished, so a
                            // throw here ends the launch at the moment of
                            // completion and masks the turn's real outcome.
                            if (!session.managedRun) session.api.push().sendSessionNotification({
                                kind: 'done',
                                metadata: session.client.getMetadata(),
                                data: {
                                    sessionId: session.client.sessionId,
                                    type: 'ready',
                                    provider: 'claude',
                                }
                            });
                        }
                    },
                    signal: abortController.signal,
                    exitAfterFirstTurn: session.exitAfterFirstTurn,
                    outputFormat: session.outputFormat,
                });

                if (remoteResult === 'turn-complete') {
                    logger.debug('[remote]: Automation turn completed, exiting run-once session');
                    exitReason = 'exit';
                }
                
                // Consume one-time Claude flags only after a command or provider
                // turn actually started. A remote→local switch can abort while
                // nextMessage() is still waiting; local mode must retain the
                // original --resume/--continue flags in that case.
                if (remoteResult !== 'not-started') {
                    session.consumeOneTimeFlags();
                }
                
                if (!exitReason && abortController.signal.aborted) {
                    session.client.closeClaudeSessionTurn('cancelled');
                    session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                }
            } catch (e) {
                if (e instanceof MandatorySandboxError) throw e;
                logger.debug('[remote]: launch error', e);
                if (!exitReason) {
                    // Reported after `finally` has flushed what the run already produced, so the
                    // failure is the last thing in the turn and closes it exactly once.
                    if (e instanceof PersonalClaudeRecheckRequired) { launchFailure = PERSONAL_RECHECK_NOTICE; }
                    else if (setupTokenSwitching?.hasAccountRefusal()) {
                        lastResultSucceeded = false;
                        const switched = await setupTokenSwitching.switchIfWanted();
                        if (switched.switched && switched.continueAfter && !lastTurnChannel && !controller.signal.aborted) continuation = mode ?? lastTurnMode;
                        launchFailure = switched.switched ? null : describeCheckpointFailure(e) ?? describeClaudeLaunchFailure(e);
                    } else launchFailure = describeCheckpointFailure(e) ?? describeClaudeLaunchFailure(e);
                    continue;
                }
            } finally {
                providerEnded = true;
                if (backgroundTasks) {
                    publishBackgroundTasks({ ...backgroundTasks, available: false });
                    backgroundTasks = undefined;
                }

                mcpController = null;
                mcpStatusReader = null;
                // The process is gone: whatever text is still buffered can
                // never be completed, so ship it as-is rather than let it
                // leak into the next launch's frames.
                streamRelay.flush();

                logger.debug('[remote]: launch finally');

                // Terminate all ongoing tool calls
                for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                    const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                    if (converted) {
                        logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                        session.client.sendClaudeSessionMessage(converted);
                    }
                }
                ongoingToolCalls.clear();

                // Flush any remaining messages in the queue
                logger.debug('[remote]: flushing message queue');
                await messageQueue.flush();
                messageQueue.destroy();
                logger.debug('[remote]: message queue flushed');
                if (launchFailure) {
                    session.client.sendSessionEvent({ type: 'message', message: launchFailure });
                    // A launch that died before its first message opened no turn; this opens one if needed.
                    session.client.failClaudeLaunchTurn();
                    launchFailure = null;
                }

                // Reset abort controller and future
                abortController = null;
                abortFuture?.resolve(undefined);
                abortFuture = null;
                logger.debug('[remote]: launch done');
                // This generation is gone; no turn of it can still be running.
                drain?.setQuery(null);
                drain?.turnEnded();
                permissionHandler.reset(undefined, 'generation-ended');
                modeHash = null;
                mode = null;
            }
        }
    } finally {
        session.cancelLessonReview();
        /*
         * The verdict for this run, reported once, and only for a run that was
         * asked to stop.
         *
         * Here rather than inside the loop: a turn can end without the run
         * ending — a mode change parks the message and relaunches — and a
         * report there was a verdict for a run still going, followed by a
         * second one when it actually ended. The supervisor reads one.
         *
         * Both halves are required, and they are read **after the provider's
         * own process has been given a chance to leave**. `claudeRemote`
         * returns as soon as its message loop ends; the SDK child exits a
         * moment later. Reading `exitedCleanly()` right away reported
         * `provider-exit-unclean` for a provider that was in the middle of
         * exiting perfectly well — the runtime then refused the checkpoint
         * with `eof-unverified`, which is a refusal caused entirely by
         * reporting too early. So wait, bounded, for the exit this
         * generation is about.
         */
        // The managed supervisor's verdict; a standalone drain reads the observer itself.
        if (gracefulStop?.requested() && session.managedRun) {
            const generation = startedGeneration();
            // Which of the two silences this is: no generation to report
            // for, or one whose exit has not been seen yet.
            logger.debug(`[managed] stop report generation=${generation ? 'present' : 'absent'}`);
            if (generation) {
                await waitForObservedExit(
                    generation.observer,
                    MANAGED_REPORT_EXIT_BUDGET_MS,
                );
            }
            reportManagedStopOutcome(
                generation?.inputExhausted && generation.observer.exitedCleanly()
                    ? MANAGED_STOP_CLEAN
                    : generation?.inputExhausted
                        ? 'provider-exit-unclean'
                        : 'input-not-exhausted',
                // The identity of the generation being reported on, or none —
                // a generation that never learned a session has nothing to
                // name, and says so.
                { nativeId: generation?.nativeId ?? null },
            );
        }

        activeInputSender = null;
        streamRelay.dispose();
        // Nothing will run it now; a state left behind would show a countdown to nothing.
        transientRetry.cancel();
        personalFallback?.cancel();
        if (personalFallback) { session.client.setPersonalClaudeFallback(undefined); session.client.setClaudeRuntimeAccount(undefined); }
        setupTokenSwitching?.dispose();

        // Clean up permission handler
        session.policyApprover = null;
        permissionHandler.reset(undefined, 'shutdown');
        permissionHandler.setAttendance(null);

        // Reset Terminal
        const t0 = Date.now();
        /*
         * The bridge points at this run's loop. Left registered, a stop
         * arriving after a mode switch would be applied to a loop that has
         * ended — or remembered and handed to the *next* run, which nobody
         * asked to stop.
         */
        registerManagedGracefulStop(null);
        logger.debug(`[remote]: cleanup begin exitReason=${exitReason} hasInk=${!!inkInstance} rawMode=${(process.stdin as any).isRaw}`);
        if (inkInstance) {
            inkInstance.unmount();
        }
        logger.debug(`[remote]: ink.unmount() done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);

        // Drain any keystrokes that landed in stdin while Ink owned it (e.g.
        // extra spaces from the double-space switch confirmation, or anything
        // typed before the user perceives that the switch has completed) so
        // they don't leak into the next interactive child process when local
        // mode takes stdin back via stdio: 'inherit'. Raw mode stays on for
        // the whole window so the kernel does not echo any in-flight bytes
        // at whatever screen position Ink last left the cursor.
        await cleanupStdinAfterInk({
            stdin: process.stdin,
            drainMs: 150,
            onDebug: (event) => {
                logger.debug(`[remote]: stdin drain ${event.bytes}B / ${event.chunks} chunk(s) +${Date.now() - t0}ms`);
            },
        });
        logger.debug(`[remote]: cleanup done +${Date.now() - t0}ms rawMode=${(process.stdin as any).isRaw}`);
        messageBuffer.clear();

        // Resolve abort future
        if (abortFuture) { // Just in case of error
            abortFuture.resolve(undefined);
        }
        // After the loop's last write: the drain may now count its output as drained.
        session.standaloneDrain?.markLoopFinished();
    }

    return exitReason || 'exit';
}

/**
 * Detect the image media type Claude accepts from the decrypted blob's
 * magic-byte header. The wire-supplied mimeType is unreliable (iOS picker
 * reports things like "image/heic" or no value at all), and the Anthropic
 * API enforces a strict enum on `image.source.base64.media_type`. Returning
 * null when the bytes don't match a supported format causes the caller to
 * drop the attachment instead of shipping an invalid request that the API
 * rejects with HTTP 400.
 */
function detectClaudeImageMime(bytes: Uint8Array): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    return null;
}
