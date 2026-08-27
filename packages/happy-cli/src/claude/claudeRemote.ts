import { EnhancedMode } from "./loop";
import { query, type QueryOptions, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import type { MessageParam } from '@anthropic-ai/sdk/resources'
import { mapToClaudeMode } from "./utils/permissionMode";
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { CHAT_TITLE_SYSTEM_PROMPT, saycodeOwnedSystemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import type { JsRuntime } from "./runClaude";
import { ORCHESTRATOR_SYSTEM_PROMPT } from "@/orchestrator/workerMcp";
import { McpRuntimeRecovery } from './mcpRuntimeRecovery';
import { McpConfigSynchronizer, type McpConfigSource } from './mcpConfigSynchronizer';
import type { McpRuntimeServerStatus } from '@slopus/happy-wire';
import { buildWorkerAgents, readWorkerConfigFromEnv } from "@/orchestrator/workerAgents";
import { buildSkillGovernanceOptions, readSkillGovernanceConfigFromEnv } from "@/orchestrator/skillGovernance";
import { readExpectedConnectors, readExpectedMcpServices } from '@/aplus/fetchAplusMcpServers';
import { buildConnectorToolGuidance, listExpectedMcpServices } from '@/aplus/connectorToolGuidance';
import { buildClaudeSystemPromptOptions } from './claudePrompt';
import { AGENT_ORCHESTRATION_SYSTEM_PROMPT } from '@/prompt/agentOrchestrationPrompt';
import { readAdditionalDirectoriesEnvironment } from '@/utils/additionalDirectoriesEnv';

export type ClaudeActiveInputSender = (text: string) => boolean;

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal; toolUseID: string }) => Promise<PermissionResult>,
    /** Called when the Query object is ready — allows permission handler to call setPermissionMode */
    onQueryReady?: (query: { setPermissionMode: (mode: string) => Promise<void> }) => void,
    /** Path to temporary settings file with SessionStart hook (required for session tracking) */
    hookSettingsPath: string,
    /** JavaScript runtime to use for spawning Claude Code (default: 'node') */
    jsRuntime?: JsRuntime,
    /** Orchestrator mode: inject worker MCP tools and system prompt */
    orchestratorMode?: boolean,
    /** MCP servers to add for orchestrator worker management */
    orchestratorMcpServers?: Record<string, unknown>,
    mcpConfig?: McpConfigSource,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: MessageParam['content'], mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onPromptSuggestionChange?: (suggestion: string | null) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,
    onMcpStatus?: (status: McpRuntimeServerStatus) => void,
    onMcpControllerReady?: (controller: Pick<McpRuntimeRecovery, 'reconnectServer'> | null) => void,
    onActiveInputReady?: (sender: ClaudeActiveInputSender | null) => void,
    onSDKMetadata?: (metadata: { tools?: string[]; slashCommands?: string[]; mcpServers?: { name: string; status: string }[]; skills?: string[]; plugins?: { name: string; path: string }[] }) => void,
    exitAfterFirstTurn?: boolean,
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return 'not-started' as const;
    }
    opts.onPromptSuggestionChange?.(null);

    // Handle special commands (extract text for parsing when content is a block array)
    const initialText = typeof initial.message === 'string'
        ? initial.message
        : (initial.message.find((b) => b.type === 'text') as { type: 'text'; text: string } | undefined)?.text ?? '';
    const specialCommand = parseSpecialCommand(initialText);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        opts.onReady();
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Prepare SDK options
    let mode = initial.mode;
    const orchestratorPrompt = opts.orchestratorMode ? ORCHESTRATOR_SYSTEM_PROMPT : undefined;

    // Per-session orchestrator/worker delegation: when a cheaper worker model is
    // declared (via HAPPY_WORKER_MODEL, applied to process.env above), register a
    // `worker` subagent bound to it and tell the main model to delegate mechanical
    // work to it. No-op when unset, so single-model sessions are unchanged.
    const workerAgents = buildWorkerAgents(readWorkerConfigFromEnv(process.env));

    // Per-machine/session skill governance: when HAPPY_SETTING_SOURCES and/or
    // HAPPY_SKILL_ALLOWLIST are set (e.g. on a Saycode-managed machine), scope
    // down which filesystem settings and skills this session loads so that
    // user-installed workflow skills (which redefine planning/TDD/review the
    // same way Saycode's own orchestration does) don't leak into managed
    // sessions. No-op when unset, so existing sessions are unchanged.
    const skillGovernance = buildSkillGovernanceOptions(readSkillGovernanceConfigFromEnv(process.env));
    const mergedMcpServers = {
        ...opts.mcpServers,
        ...(opts.orchestratorMode ? opts.orchestratorMcpServers : {}),
    };
    const connectorGuidance = buildConnectorToolGuidance(listExpectedMcpServices({
        expectedConnectors: readExpectedConnectors(),
        expectedMcpServices: readExpectedMcpServices(),
        configuredServerNames: Object.keys(mergedMcpServers),
    }));
    const promptOptions = buildClaudeSystemPromptOptions({
        customSystemPrompt: initial.mode.customSystemPrompt,
        appendSystemPrompt: initial.mode.appendSystemPrompt,
        chatTitlePrompt: CHAT_TITLE_SYSTEM_PROMPT,
        saycodeSystemPrompt: saycodeOwnedSystemPrompt,
        agentOrchestrationPrompt: AGENT_ORCHESTRATION_SYSTEM_PROMPT,
        orchestratorPrompt,
        workerDelegationPrompt: workerAgents.delegationPrompt,
        connectorGuidance,
        saycodeSystemPromptEnabled: initial.mode.saycodeSystemPromptEnabled,
        saycodePromptBlocks: initial.mode.saycodePromptBlocks,
    });

    const hasMcpServers = Object.keys(mergedMcpServers).length > 0;
    const sdkOptions: QueryOptions = {
        cwd: opts.path,
        additionalDirectories: readAdditionalDirectoriesEnvironment(process.env),
        resume: startFrom ?? undefined,
        mcpServers: hasMcpServers ? mergedMcpServers : undefined,
        permissionMode: mapToClaudeMode(initial.mode.permissionMode),
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: promptOptions.customSystemPrompt,
        appendSystemPrompt: promptOptions.appendSystemPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        effort: initial.mode.effort,
        agents: workerAgents.agents,
        settingSources: skillGovernance.settingSources,
        skills: skillGovernance.skills,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal; toolUseID: string }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        settingsPath: opts.hookSettingsPath,
        promptSuggestions: true,
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        parent_tool_use_id: null,
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });
    const mcpRecovery = new McpRuntimeRecovery(response, { onStatus: opts.onMcpStatus });
    const mcpConfigSynchronizer = opts.mcpConfig
        ? new McpConfigSynchronizer(response, { ...opts.mcpConfig, onStatus: opts.onMcpStatus })
        : null;

    // Expose query control methods to permission handler
    if (opts.onQueryReady) {
        opts.onQueryReady({
            setPermissionMode: (mode: string) => response.setPermissionMode(mode as any),
        });
    }

    updateThinking(true);
    let acceptsActiveInput = true;
    const sendActiveInput: ClaudeActiveInputSender = (text) => {
        if (!acceptsActiveInput || messages.done || !text.trim()) {
            return false;
        }
        messages.push({
            type: 'user',
            parent_tool_use_id: null,
            message: { role: 'user', content: text },
        });
        return true;
    };
    opts.onActiveInputReady?.(sendActiveInput);
    let acceptsPromptSuggestion = false;
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            if (message.type === 'prompt_suggestion') {
                if (acceptsPromptSuggestion) {
                    acceptsPromptSuggestion = false;
                    const suggestion = message.suggestion.trim();
                    if (suggestion) {
                        opts.onPromptSuggestionChange?.(suggestion);
                    }
                }
                continue;
            }

            // Handle messages. During /compact, Claude emits the generated
            // summary as a normal assistant text message before the result.
            // Mark it so downstream UI/protocol mapping can treat it as
            // housekeeping instead of a real assistant response.
            const outboundMessage = isCompactCommand && message.type === 'assistant'
                ? { ...message, isCompactSummary: true } as SDKMessage
                : message;
            opts.onMessage(outboundMessage);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                // Emit SDK metadata (tools, slash commands) from init message
                if (opts.onSDKMetadata) {
                    opts.onSDKMetadata({
                        tools: systemInit.tools,
                        slashCommands: systemInit.slash_commands,
                        mcpServers: systemInit.mcp_servers?.map(s => ({ name: s.name, status: s.status })),
                        skills: systemInit.skills,
                        plugins: systemInit.plugins?.map(p => ({ name: p.name, path: p.path })),
                    });
                }

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`), 30000);
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    if (!found) {
                        // The transcript never landed on disk within the grace
                        // window. We still register the id so the (now
                        // bounded) scanner watcher can pick it up if it shows
                        // up late and otherwise drops it cleanly instead of
                        // wedging — but surface the anomaly so a stuck remote
                        // launch is visible in the app rather than a silent
                        // "dead instance".
                        logger.debug(`[claudeRemote] WARNING: session transcript ${systemInit.session_id} never appeared after 30s`);
                        opts.onCompletionEvent?.('⚠️ Claude session did not produce a transcript — the agent may be unresponsive. Try sending your message again.');
                    }
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                acceptsPromptSuggestion = true;
                acceptsActiveInput = false;
                opts.onActiveInputReady?.(null);
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');
                opts.onMcpControllerReady?.(mcpRecovery);

                await mcpRecovery.recoverFailedServers();

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                if (opts.exitAfterFirstTurn) {
                    return 'turn-complete' as const;
                }

                // Wait for next user message without blocking the message loop.
                // Background task messages (task_started, task_progress, task_notification)
                // continue flowing through while we wait for user input.
                opts.nextMessage().then(async (next) => {
                    if (!next) {
                        messages.end();
                    } else {
                        await mcpConfigSynchronizer?.sync();
                        acceptsPromptSuggestion = false;
                        opts.onPromptSuggestionChange?.(null);
                        opts.onMcpControllerReady?.(null);
                        mode = next.mode;
                        acceptsActiveInput = true;
                        opts.onActiveInputReady?.(sendActiveInput);
                        messages.push({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: next.message } });
                    }
                }).catch(() => {
                    messages.end();
                });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        acceptsActiveInput = false;
        opts.onActiveInputReady?.(null);
        opts.onMcpControllerReady?.(null);
        updateThinking(false);
    }
    return undefined;
}
