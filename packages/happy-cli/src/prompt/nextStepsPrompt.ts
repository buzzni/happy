import { NEXT_STEP_ACTION_KINDS } from '@slopus/happy-wire';

/**
 * Saycode specs/desktop-next-steps-card — when to fill the turn-end card (`next_steps`) and, on
 * Codex, the task list (`update_plan`). Saycode-owned guidance under the master prompt switch:
 * with it off the tools stay registered and simply go uncalled, which draws nothing.
 */
const NEXT_STEPS_RULES = [
  'Before you end a turn in which you changed files, ran commands, or finished multi-step work, call "mcp__happy__next_steps" once: summary is two or three sentences on what is now true and what is not done or not verified; question is the one decision left to the user, only when there is one; actions are the buttons that answer it, your pick first. Skip it for short answers and pure conversation.',
  `Use an app action (${NEXT_STEP_ACTION_KINDS.join(', ')}) only when it holds right now — no commit without uncommitted changes, no merge without an open pull request, no fix_ci without a failing check. Otherwise use a reply button {label, message}. When the card has a question, write nothing after the call.`,
];

const PLAN_RULE = 'For a request that edits files or runs more than one command, keep the task list the app shows with "mcp__happy__update_plan": the whole list with each step\'s status, scope first_task, continuation or new_task. Send it in the same message as another tool call, not on its own, and update it as steps finish.';

const wrap = (lines: string[]) => ['<saycode-next-steps>', ...lines, '</saycode-next-steps>'].join('\n');

/** Claude keeps its task list with TodoWrite, so it gets the card rules only. */
export const CLAUDE_NEXT_STEPS_PROMPT = wrap(NEXT_STEPS_RULES);
export const CODEX_NEXT_STEPS_PROMPT = wrap([PLAN_RULE, ...NEXT_STEPS_RULES]);
