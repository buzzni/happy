/**
 * The rows of the live background-task list a Claude session publishes as `claudeBackgroundTasks`
 * (aplus-dev-studio-desktop specs/agent-background-work-panel R1).
 *
 * `background_tasks_changed` replaces the whole set and carries only ids, types and descriptions.
 * The background-work panel also shows when each task started and, for a shell or a monitor, its
 * command: a task keeps the time it was first listed, and its command comes from the Bash/Monitor
 * `tool_use` its `task_started` names. The level usually precedes that bookend, so a command learned
 * after the task is listed is attached with {@link ClaudeBackgroundTaskDetails.withCommands}.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Metadata } from '@/api/types';

export type ClaudeBackgroundTaskEntry = NonNullable<NonNullable<Metadata['claudeBackgroundTasks']>['tasks']>[number];

type ListedTask = { task_id: string; task_type: string; description: string };

const COMMAND_TOOLS = new Set(['Bash', 'Monitor']);
const MAX_REMEMBERED = 64;
const MAX_COMMAND_LENGTH = 1000;

function remember<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    map.set(key, value);
    if (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value!);
}

export function createClaudeBackgroundTaskDetails(now: () => number = Date.now) {
    const toolUses = new Map<string, { command: string; toolName: string }>();
    const origins = new Map<string, { command: string; toolName: string }>();
    const startedAt = new Map<string, number>();

    return {
        /**
         * Records the command of a Bash/Monitor call and links a started task to it. Returns the id
         * of the task whose command this message made known, so a list already naming it can be republished.
         */
        observe(message: SDKMessage): string | null {
            if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
                for (const block of message.message.content as Array<{ type?: unknown; id?: unknown; name?: unknown; input?: unknown }>) {
                    const command = (block.input as { command?: unknown } | undefined)?.command;
                    if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string'
                        || !COMMAND_TOOLS.has(block.name) || typeof command !== 'string' || !command.trim()) continue;
                    remember(toolUses, block.id, { command: command.trim().slice(0, MAX_COMMAND_LENGTH), toolName: block.name });
                }
                return null;
            }
            if (message.type !== 'system' || message.subtype !== 'task_started' || !message.tool_use_id) return null;
            const origin = toolUses.get(message.tool_use_id);
            if (!origin) return null;
            remember(origins, message.task_id, origin);
            return message.task_id;
        },
        /** The rows for one full list; a task listed before keeps its start time. */
        list(tasks: readonly ListedTask[]): ClaudeBackgroundTaskEntry[] {
            const at = now();
            const rows = tasks.map((task): ClaudeBackgroundTaskEntry => {
                const origin = origins.get(task.task_id);
                return {
                    taskId: task.task_id,
                    label: task.description,
                    kind: task.task_type.includes('bash') ? 'shell' : 'agent',
                    taskType: task.task_type,
                    startedAt: startedAt.get(task.task_id) ?? at,
                    ...(origin ? { command: origin.command, toolName: origin.toolName } : {}),
                };
            });
            startedAt.clear();
            for (const row of rows) startedAt.set(row.taskId, row.startedAt!);
            return rows;
        },
        /** The same rows with any command learned since they were listed. */
        withCommands(rows: readonly ClaudeBackgroundTaskEntry[]): ClaudeBackgroundTaskEntry[] {
            return rows.map(row => {
                const origin = row.command ? undefined : origins.get(row.taskId);
                return origin ? { ...row, command: origin.command, toolName: origin.toolName } : row;
            });
        },
    };
}

export type ClaudeBackgroundTaskDetails = ReturnType<typeof createClaudeBackgroundTaskDetails>;
