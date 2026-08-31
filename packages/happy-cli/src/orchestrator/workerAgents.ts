/**
 * Per-session orchestrator/worker delegation via the Claude Agent SDK's native
 * `agents` option.
 *
 * When a session declares a cheaper worker model, we register a single `worker`
 * subagent bound to that model and append an orchestrator system prompt telling
 * the main (expensive) model to delegate mechanical, token-heavy execution to it.
 * The main model plans/judges; the worker executes on a cheaper model — cutting
 * token cost (or, on a Claude Code subscription, usage-limit consumption).
 *
 * This replaces the never-wired `orchestrator/workerMcp.ts` skeleton: the SDK
 * spawns and routes the worker through the built-in Agent/Task tool, so no
 * custom MCP worker server is needed.
 *
 * `AgentDefinition.model` accepts a model alias ('fable' | 'opus' | 'sonnet' |
 * 'haiku') or a full model id; omitted/'inherit' means "use the main model"
 * (which would defeat the cost saving), so we only register the worker when an
 * explicit, non-inherit model is provided.
 */

import type { AgentDefinition } from '@anthropic-ai/claude-agent-sdk'
import { normalizeClaudeModelForRuntime } from '@/utils/initialPrompt'

/** The single subagent name the orchestrator prompt tells the model to delegate to. */
export const WORKER_AGENT_NAME = 'worker'

export type WorkerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const VALID_EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/** A model value that means "inherit the main model" — no cost saving, so skip. */
const INHERIT_MODEL_VALUES: ReadonlySet<string> = new Set(['', 'inherit', 'default'])

export interface WorkerConfig {
    /** Model alias or full id for the worker subagent. Falsy/'inherit' → disabled. */
    workerModel?: string | null
    /** Reasoning effort for the worker subagent. Invalid/absent → SDK default. */
    workerEffort?: string | null
}

export interface WorkerAgentsResult {
    /** Passed straight to QueryOptions.agents; undefined when delegation is disabled. */
    agents?: Record<string, AgentDefinition>
    /** Appended to the orchestrator system prompt; '' when delegation is disabled. */
    delegationPrompt: string
}

/** System prompt for the delegated worker subagent. */
const WORKER_PROMPT = [
    'You are an execution worker delegated a well-scoped subtask by an orchestrator.',
    'Complete exactly what was asked within the given scope and files. Do not redesign,',
    'refactor beyond the request, or expand scope. Run the verification commands you were',
    'given. If the task is underspecified or you hit a real blocker, stop and report back',
    'concisely rather than guessing.',
].join(' ')

/** Description drives the Agent tool routing — when the orchestrator should delegate. */
const WORKER_DESCRIPTION = [
    'Use for mechanical, token-heavy execution that does not need top-tier judgment:',
    'implementing well-specified changes, boilerplate, multi-file refactors/renames,',
    'running tests, and gathering or summarizing files. Give it a precise objective,',
    'in/out-of-scope files, and verification commands.',
].join(' ')

/** Appended to the orchestrator (main model) system prompt when delegation is on. */
const DELEGATION_PROMPT = [
    'You are the orchestrator. Plan, decompose, make judgment calls, and review results yourself.',
    'If the user asks for a child that is visible, reopenable, or controllable later, do not use this Task/Agent worker;',
    'follow the Saycode child-session instructions and use happy agent instead.',
    `Delegate mechanical, token-heavy execution to the \`${WORKER_AGENT_NAME}\` subagent via the`,
    'Task/Agent tool to save cost: implementing well-specified changes, boilerplate, multi-file',
    'refactors, running tests, and research/summarization. When delegating, give the worker the',
    'target path, objective, in/out-of-scope files, verification commands, and completion criteria.',
    'Reserve your own turns for the hard reasoning, design, and final judgment.',
].join(' ')

/** Reads the per-session worker config from a process env-like record (pure). */
export function readWorkerConfigFromEnv(env: Record<string, string | undefined>): WorkerConfig {
    return {
        workerModel: normalizeClaudeModelForRuntime(env.HAPPY_WORKER_MODEL, env),
        workerEffort: env.HAPPY_WORKER_EFFORT,
    }
}

function normalizeEffort(effort: string | null | undefined): WorkerEffort | undefined {
    if (effort && VALID_EFFORTS.has(effort)) return effort as WorkerEffort
    return undefined
}

/**
 * Builds the SDK `agents` map and orchestrator prompt suffix for a session.
 * Returns a no-op result (no agents, empty prompt) when no explicit worker model
 * is set, so existing single-model sessions are 100% unchanged.
 */
export function buildWorkerAgents(config: WorkerConfig): WorkerAgentsResult {
    const model = config.workerModel?.trim()
    if (!model || INHERIT_MODEL_VALUES.has(model.toLowerCase())) {
        return { delegationPrompt: '' }
    }

    const worker: AgentDefinition = {
        description: WORKER_DESCRIPTION,
        prompt: WORKER_PROMPT,
        model,
    }
    const effort = normalizeEffort(config.workerEffort)
    if (effort) worker.effort = effort

    return {
        agents: { [WORKER_AGENT_NAME]: worker },
        delegationPrompt: DELEGATION_PROMPT,
    }
}
