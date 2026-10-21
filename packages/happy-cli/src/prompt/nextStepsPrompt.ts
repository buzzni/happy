import { NEXT_STEP_ACTION_KINDS } from '@slopus/happy-wire';

/**
 * Saycode specs/desktop-next-steps-card — when to fill the turn-end card (`next_steps`). Sent only
 * on a turn whose client said it draws the card (the `nextSteps` prompt block), under the master
 * prompt switch. The task list is not here: Claude Code keeps it with TodoWrite and Codex with its
 * built-in update_plan, and the app shows both.
 */
export const NEXT_STEPS_PROMPT = [
  '<saycode-next-steps>',
  'Before you end a turn in which you changed files, ran commands, or finished multi-step work, call "mcp__happy__next_steps" once: summary is two or three sentences on what is now true and what is not done or not verified; question is the one decision left to the user, only when there is one; actions are the buttons that answer it, your pick first. Skip it for short answers and pure conversation.',
  `Use an app action (${NEXT_STEP_ACTION_KINDS.join(', ')}) only when it holds right now — no commit without uncommitted changes, no merge without an open pull request, no fix_ci without a failing check. Otherwise use a reply button {label, message}. When the card has a question, write nothing after the call. If the call is refused, put the recap and question in your closing message instead.`,
  '</saycode-next-steps>',
].join('\n');
