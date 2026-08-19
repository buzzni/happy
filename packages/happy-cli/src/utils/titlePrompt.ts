import { BRANCH_SLUG_SPEC } from "@/utils/branchSlugSpec";
import { trimIdent } from "@/utils/trimIdent";

/**
 * Per-turn nudge appended to the user's message until the chat has a title.
 * Shared by the Claude backend and the ACP backend (gemini/opencode/grok), which
 * is why it lives outside `src/claude/`.
 *
 * Why a per-turn message nudge and not just the base system prompt: the base
 * system prompt already carries this instruction, but it sits at the top of a
 * large, static prompt and the model routinely skips it — especially while a
 * long first turn is running. Placing the instruction at the end of the actual
 * user turn (as the Codex backend already does) makes it salient enough that
 * the model reliably calls `change_title`. This only touches the text handed to
 * the model; the visible user bubble is the app's own copy, and the modified
 * turn is de-duped by recording it with the JSONL scanner.
 */
export const TITLE_INSTRUCTION = trimIdent(`
    Before you do anything else for this message, call the "mcp__happy__change_title" tool exactly once to set a concise title for this chat — a short noun phrase naming the task, in the user's language — and a branchSlug: ${BRANCH_SLUG_SPEC} Do it now even if the task itself takes a while. The title locks after it is first set, so do not call it again.
`);

/**
 * Append the title instruction to a user turn's text.
 *
 * Returns the text unchanged when it is empty/whitespace — there is nothing to
 * derive a title from, and sending the instruction on its own would be noise.
 */
export function appendTitleInstruction(text: string): string {
    const base = text ?? '';
    if (base.trim().length === 0) {
        return base;
    }
    return `${base}\n\n${TITLE_INSTRUCTION}`;
}
