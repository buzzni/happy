/**
 * Turn card (Saycode specs/desktop-next-steps-card): `next_steps` fills the "next step" box a
 * client draws at the end of a turn. It only records a session event — the client decides what a
 * button does, so an app action is a name from a fixed list, never a command.
 *
 * The card exists only where a client draws it, and the daemon cannot see the screen. So the
 * client that sends a turn says so (`saycodePromptBlocks.nextSteps` in that message's meta) and
 * the tool takes the card only on such a turn. On any other turn — an older Desktop, the mobile
 * app, a Slack channel, an initial prompt — it refuses, so the model puts its recap and question
 * in its closing message where every client shows it.
 *
 * `archive_conversation` (Saycode specs/chat-agent-self-archive) rides the same per-turn switch:
 * the user asked in chat to archive this conversation, and the client that sent the turn archives
 * it once the turn has ended. Archiving stops this process, so the tool only records the request.
 * It follows its own capability (`saycodePromptBlocks.archiveRequest`), not the card's: the card
 * sits under the Saycode instructions switch, archiving by request must not.
 *
 * Runners: Claude and Codex wire the per-turn switch. Any other runner (ACP: Gemini, OpenCode, …)
 * is outside this feature; the tool still answers, with a refusal. The task list is not a tool
 * here: Claude Code's TodoWrite and Codex's built-in `update_plan` already keep it, and Codex's
 * list reaches the client as a `plan` event (see codex/codexPlanEvent.ts).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
    createEnvelope,
    NEXT_STEP_ACTION_KINDS,
    NEXT_STEPS_LIMITS,
    type SessionEvent,
} from '@slopus/happy-wire';
import type { ApiSessionClient } from '@/api/apiSession';
import { logger } from '@/ui/logger';

export type TurnCardRunner = 'claude' | 'codex';

/** Whether the turn now running came from a client that draws the card / archives on request. */
export type TurnCards = { runner: TurnCardRunner; drawn: () => boolean; archives: () => boolean };

/** The per-turn switch a runner flips when it starts a turn with that turn's prompt blocks. */
export type TurnCardSwitch = TurnCards & { set: (drawn: boolean) => void; setArchives: (archives: boolean) => void };

export function createTurnCardSwitch(runner: TurnCardRunner): TurnCardSwitch {
    let drawn = false;
    let archives = false;
    return {
        runner,
        drawn: () => drawn,
        archives: () => archives,
        set: (next) => { drawn = next; },
        setArchives: (next) => { archives = next; },
    };
}

/** Tool names (without the `mcp__happy__` prefix) this module registers. */
export const TURN_CARD_TOOL_NAMES = ['next_steps', 'archive_conversation'] as const;

type ToolReply = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
type RunTool = (work: () => Promise<ToolReply>) => Promise<ToolReply>;

const reply = (text: string, isError = false): ToolReply => ({ content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });

// Trimmed so whitespace-only text is refused here instead of reaching a client that drops it.
const text = (max: number) => z.string().trim().min(1).max(max);

const appAction = z.object({
    kind: z.enum(NEXT_STEP_ACTION_KINDS).describe('An app action button. Include it only when it holds right now.'),
    label: text(NEXT_STEPS_LIMITS.label).optional().describe('Optional button text; the app has its own.'),
}).strict();
const replyAction = z.object({
    label: text(NEXT_STEPS_LIMITS.label).describe('Button text, in the user\'s words.'),
    message: text(NEXT_STEPS_LIMITS.message).describe('Sent to you as the user\'s next message when clicked. The user sees it before sending.'),
}).strict();

const nextStepsInput = {
    summary: text(NEXT_STEPS_LIMITS.summary)
        .describe('Two or three sentences to the user: what is now true or changed, then what is not done or not verified.'),
    question: text(NEXT_STEPS_LIMITS.question).optional()
        .describe('The one decision left to the user, in one short sentence. Only when the next move is theirs.'),
    actions: z.array(z.union([appAction, replyAction])).max(NEXT_STEPS_LIMITS.actions)
        .describe(`Buttons that answer the question; the first is the primary one. App actions: ${NEXT_STEP_ACTION_KINDS.join(', ')}.`),
};

type NextStepsArgs = z.infer<z.ZodObject<typeof nextStepsInput>>;

const UNSUPPORTED = 'NEXT_STEPS_UNSUPPORTED: the app this turn came from does not show a next-steps card. Put your recap, and any question for the user, in your closing message.';

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

export function registerTurnCardTools(mcp: McpServer, options: {
    client: ApiSessionClient;
    turnCards: TurnCards | undefined;
    runTool: RunTool;
}): void {
    const { client, turnCards, runTool } = options;

    mcp.registerTool('next_steps', {
        title: 'Next steps',
        // Unconditional "call it every turn" wording would invite calls on turns whose client draws
        // no card; the when-to-call rules ride only in that turn's <saycode-next-steps> guidance.
        description: 'Fill the "next step" card the app shows at the end of your turn: a short recap and, when the user has a decision to make, one question with buttons that answer it. Call it only when your instructions contain <saycode-next-steps>, and follow them; otherwise do not call it. Only include an app action that holds right now; otherwise use a reply button {label, message}. If it is refused, end your turn with an ordinary message instead.',
        inputSchema: nextStepsInput,
    }, async (args) => runTool(async () => {
        if (!turnCards?.drawn()) return reply(UNSUPPORTED, true);
        const refusal = nextStepsRefusal(args);
        if (refusal) return reply(refusal, true);
        const ev: SessionEvent = {
            t: 'next-steps',
            summary: args.summary,
            ...(args.question ? { question: args.question } : {}),
            actions: args.actions,
        };
        try {
            client.sendSessionProtocolMessage(createEnvelope('agent', ev));
        } catch (error) {
            logger.debug(`[happyMCP] next_steps record failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply('NEXT_STEPS_NOT_RECORDED: the card could not be recorded. End your turn with an ordinary message that says the same.', true);
        }
        return reply(args.question
            ? 'Shown: the card with your recap, question and buttons is under this turn. Write nothing more; the user answers with a button or a message.'
            : 'Shown: the recap is under this turn. If you have more to say, say it now in a short closing message.');
    }));

    mcp.registerTool('archive_conversation', {
        title: 'Archive this conversation',
        description: 'Archive this conversation (move it to Done on the agent board) after your reply ends. Call it only when the user explicitly asked in this turn to archive, close or finish this conversation. The app archives it after your turn; the user can undo. If it is refused, tell the user to archive it from the app instead.',
        inputSchema: {},
    }, async () => runTool(async () => {
        if (!turnCards?.archives()) {
            return reply('ARCHIVE_UNSUPPORTED: the app this turn came from does not archive on request. Tell the user to archive the conversation from the app.', true);
        }
        try {
            client.sendSessionProtocolMessage(createEnvelope('agent', { t: 'archive-request' }));
        } catch (error) {
            logger.debug(`[happyMCP] archive_conversation record failed: ${error instanceof Error ? error.message : String(error)}`);
            return reply('ARCHIVE_NOT_RECORDED: the request could not be recorded. Tell the user to archive the conversation from the app.', true);
        }
        return reply('Requested: the app archives this conversation after your reply ends, and the user can undo it. Say so in one short sentence; do not say it is already archived.');
    }));
}
