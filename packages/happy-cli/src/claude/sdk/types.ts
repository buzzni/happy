/**
 * Type definitions for Claude Code SDK integration
 * Re-exports from official @anthropic-ai/claude-agent-sdk with adapter types
 */

// Re-export message types from official SDK
export type {
    SDKMessage,
    SDKUserMessage,
    SDKAssistantMessage,
    SDKSystemMessage,
    SDKResultMessage,
    PermissionResult,
    CanUseTool,
    AgentDefinition,
} from '@anthropic-ai/claude-agent-sdk'

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'

// Re-export AbortError class
export { AbortError } from '@anthropic-ai/claude-agent-sdk'

// Alias for backward compatibility
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk'
export type CanCallToolCallback = CanUseTool

/**
 * Adapter type for query options.
 * Maps to official SDK's Options type but preserves existing field names
 * used throughout the codebase. The query() wrapper handles the translation.
 */
export interface QueryOptions {
    abort?: AbortSignal
    allowedTools?: string[]
    appendSystemPrompt?: string
    customSystemPrompt?: string
    cwd?: string
    disallowedTools?: string[]
    maxTurns?: number
    /** Emit Claude's predicted next user prompt after completed turns. */
    promptSuggestions?: boolean
    mcpServers?: Record<string, unknown>
    permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
    continue?: boolean
    resume?: string
    model?: string
    fallbackModel?: string
    strictMcpConfig?: boolean
    canCallTool?: CanCallToolCallback
    /** Path to a settings JSON file to pass to Claude via --settings */
    settingsPath?: string
    /**
     * Effort level passed straight through to the Claude Agent SDK option
     * of the same name — controls how much thinking/reasoning Claude
     * applies on each turn ('low' | 'medium' | 'high' | 'xhigh' | 'max').
     * 'xhigh' is supported on the newest Opus generation (e.g. Opus 4.8);
     * the SDK silently downgrades it to 'high' on models without it.
     */
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    /**
     * Programmatically-defined custom subagents, keyed by name, forwarded to the
     * SDK's `agents` option. Used for per-session orchestrator/worker delegation:
     * a cheaper `worker` agent the (expensive) main model delegates mechanical
     * work to. See orchestrator/workerAgents.ts.
     */
    agents?: Record<string, AgentDefinition>
}

/**
 * Query prompt types
 */
import type { SDKMessage as _SDKMessage } from '@anthropic-ai/claude-agent-sdk'
export type QueryPrompt = string | AsyncIterable<_SDKMessage>
