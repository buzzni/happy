import { BRANCH_SLUG_SPEC } from "@/utils/branchSlugSpec";
import { trimIdent } from "@/utils/trimIdent";
import { shouldIncludeCoAuthoredBy } from "./claudeSettings";

/**
 * Chat title instruction. Product plumbing, not Saycode-owned behavioral
 * guidance: without it the `change_title` tool stays registered but nothing
 * tells the model to call it, and every client's chat list shows untitled
 * chats. Exported on its own so callers can keep it while dropping the
 * Saycode-owned blocks (see claudePrompt.ts).
 */
export const CHAT_TITLE_SYSTEM_PROMPT = (() => trimIdent(`
    ALWAYS when you start a new chat - you must call a tool "mcp__happy__change_title" once to generate a concise title that represents the user's task, unless the chat already has one. This title is needed to easily find the chat in the future. Help human. Pass a branchSlug too: ${BRANCH_SLUG_SPEC} The title locks after it is first set, so do not call change_title again.
`))();

/**
 * Co-authored-by credits to append when enabled
 */
const CO_AUTHORED_CREDITS = (() => trimIdent(`
    When making commit messages, instead of just giving co-credit to Claude, also give credit to Happy like so:

    <main commit message>

    Generated with [Claude Code](https://claude.ai/code)
    via [Happy](https://happy.engineering)

    Co-Authored-By: Claude <noreply@anthropic.com>
    Co-Authored-By: Happy <yesreply@happy.engineering>
`))();

/**
 * The Saycode-gated half of the prompt: Happy's commit credits. Empty when the
 * user's Claude settings opt out of Co-Authored-By, so callers can pass it
 * unconditionally and let the per-block gate decide.
 *
 * Deliberately kept separate from {@link CHAT_TITLE_SYSTEM_PROMPT} rather than
 * pre-joined: a combined export would let a caller inject the credits past the
 * `coAuthoredCredit` gate just by picking the convenient constant.
 * Settings are read once on startup for performance.
 */
export const saycodeOwnedSystemPrompt = (() => (shouldIncludeCoAuthoredBy() ? CO_AUTHORED_CREDITS : ''))();
