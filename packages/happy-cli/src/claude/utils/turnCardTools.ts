/**
 * Turn cards (Saycode specs/desktop-next-steps-card): `next_steps` fills the "next step" box a
 * client draws at the end of a turn, and `update_plan` keeps the task list it draws under the
 * latest message. Both only record a session event — the client decides what a button does, so
 * an app action is a name from a fixed list, never a command.
 *
 * Runners differ on purpose:
 * - Claude gets `next_steps` only. Claude Code's TodoWrite already is the task list, and the app
 *   renders it; a second list tool would split the plan in two.
 * - Codex gets both.
 * - Any other runner (ACP: Gemini, OpenCode, …) is outside this feature. The tools still answer,
 *   with a refusal, so an agent that finds them learns why instead of guessing.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    createEnvelope,
    NEXT_STEP_ACTION_KINDS,
    NEXT_STEPS_LIMITS,
    PLAN_LIMITS,
    PLAN_SCOPES,
    PLAN_STEP_STATUSES,
    type SessionEvent,
} from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

export type TurnCardRunner = 'claude' | 'codex';

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type RunTool = (work: () => Promise<ToolReply>) => Promise<ToolReply>;

/** Tool names (without the `mcp__happy__` prefix) a runner is offered. */
export function turnCardToolNames(runner: TurnCardRunner | undefined): string[] {
    return runner === 'claude' ? ['next_steps'] : ['next_steps', 'update_plan'];
}

const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

const appAction = z.object({
    kind: z.enum(NEXT_STEP_ACTION_KINDS).describe('An app action button. Include it only when it holds right now.'),
    label: z.string().min(1).max(NEXT_STEPS_LIMITS.label).optional().describe('Optional button text; the app has its own.'),
}).strict();
const replyAction = z.object({
    label: z.string().min(1).max(NEXT_STEPS_LIMITS.label).describe('Button text, in the user\'s words.'),
    message: z.string().min(1).max(NEXT_STEPS_LIMITS.message).describe('Sent to you as the user\'s next message when clicked.'),
}).strict();

const nextStepsInput = {
    summary: z.string().min(1).max(NEXT_STEPS_LIMITS.summary)
        .describe('Two or three sentences to the user: what is now true or changed, then what is not done or not verified.'),
    question: z.string().min(1).max(NEXT_STEPS_LIMITS.question).optional()
        .describe('The one decision left to the user, in one short sentence. Only when the next move is theirs.'),
    actions: z.array(z.union([appAction, replyAction])).max(NEXT_STEPS_LIMITS.actions)
        .describe(`Buttons that answer the question; the first is the primary one. App actions: ${NEXT_STEP_ACTION_KINDS.join(', ')}.`),
};

const planInput = {
    scope: z.enum(PLAN_SCOPES).describe('first_task: the session\'s first request. continuation: more of the current task. new_task: an unrelated request.'),
    steps: z.array(z.object({
        text: z.string().min(1).max(PLAN_LIMITS.text),
        status: z.enum(PLAN_STEP_STATUSES),
    }).strict()).min(1).max(PLAN_LIMITS.steps).describe('The whole list, in order; it replaces the previous one.'),
};

type NextStepsArgs = z.infer<z.ZodObject<typeof nextStepsInput>>;

/** Rules the schema cannot say. Returns a refusal code and reason, or null when the card stands. */
function nextStepsRefusal(args: NextStepsArgs): string | null {
    if (args.question && args.actions.length === 0) {
        return 'NEXT_STEPS_QUESTION_WITHOUT_ACTIONS: a question needs at least one button that answers it. Add the buttons, or drop the question and ask it in your closing message.';
    }
    const kinds = args.actions.flatMap((action) => 'kind' in action ? [action.kind] : []);
    const repeated = kinds.find((kind, index) => kinds.indexOf(kind) !== index);
    if (repeated) return `NEXT_STEPS_DUPLICATE_ACTION: ${repeated} appears more than once. Give each app action one button.`;
    return null;
}

function record(client: ApiSessionClient, ev: SessionEvent): void {
    client.sendSessionProtocolMessage(createEnvelope('agent', ev));
}

export function registerTurnCardTools(mcp: McpServer, options: {
    client: ApiSessionClient;
    runner: TurnCardRunner | undefined;
    runTool: RunTool;
}): void {
    const { client, runner, runTool } = options;

    mcp.registerTool('next_steps', {
        title: 'Next steps',
        description: 'Fill the "next step" card the app shows at the end of your turn: a short recap and, when the user has a decision to make, one question with buttons that answer it. Call it once before you end a turn in which you changed files, ran commands, or finished multi-step work; skip it for short answers. Only include an app action that holds right now; otherwise use a reply button {label, message}. When the card has a question, write nothing after this call.',
        inputSchema: nextStepsInput,
    }, async (args) => runTool(async () => {
        if (!runner) return reply('NEXT_STEPS_UNSUPPORTED: this agent runner\'s app does not show a next-steps card. End your turn with an ordinary message.', true);
        const refusal = nextStepsRefusal(args);
        if (refusal) return reply(refusal, true);
        const ev: SessionEvent = {
            t: 'next-steps',
            summary: args.summary,
            ...(args.question ? { question: args.question } : {}),
            actions: args.actions,
        };
        try {
            record(client, ev);
        } catch (error) {
            logger.debug(`[happyMCP] next_steps record failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply('NEXT_STEPS_NOT_RECORDED: the card could not be recorded. End your turn with an ordinary message that says the same.', true);
        }
        return reply(args.question
            ? 'Shown: the card with your recap, question and buttons is under this turn. Write nothing more; the user answers with a button or a message.'
            : 'Shown: the recap is under this turn. If you have more to say, say it now in a short closing message.');
    }));

    if (runner === 'claude') return;

    mcp.registerTool('update_plan', {
        title: 'Update task list',
        description: 'Keep the task list the app shows under your latest message. Send the whole list each time (it replaces the previous one) with each step\'s status. Use it for any request that edits files or runs more than one command, and send it in the same message as another tool call rather than on its own.',
        inputSchema: planInput,
    }, async (args) => runTool(async () => {
        if (runner !== 'codex') return reply('PLAN_UNSUPPORTED: this agent runner\'s app does not show this task list. Keep your plan in your messages.', true);
        try {
            record(client, { t: 'plan', scope: args.scope, steps: args.steps });
        } catch (error) {
            logger.debug(`[happyMCP] update_plan record failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply('PLAN_NOT_RECORDED: the task list could not be recorded. Carry on with your work.', true);
        }
        return reply('Updated: the app shows this list under your latest message.');
    }));
}
