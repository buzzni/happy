/**
 * The branchSlug wording shared by every prompt that asks for a chat title.
 *
 * Three separate places instruct the model to call change_title — the always-on
 * base system prompt (claude/utils/systemPrompt.ts), the per-turn Claude nudge
 * (claude/utils/titlePrompt.ts), and the Codex/Gemini turn instruction
 * (gemini/constants.ts). When this spec was written out at each site, one of the
 * three was missed, which silently left that path unable to produce a slug.
 * Single-sourcing the sentence is what keeps them from drifting apart again.
 *
 * Each site supplies its own lead-in ("and a branchSlug: ", "Pass a branchSlug
 * too: ") and appends this.
 */
export const BRANCH_SLUG_SPEC =
    "a short English kebab-case slug (2-4 words, lowercase, hyphen-separated, no punctuation) summarizing the same task, for use as a git branch name regardless of the title's language.";
