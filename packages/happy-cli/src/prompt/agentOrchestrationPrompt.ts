import { wrapSaycodeOwnedPrompt } from '@slopus/happy-wire';
import { trimIdent } from '@/utils/trimIdent';

const ROUTING_GUIDANCE = trimIdent(`
  Saycode child-session orchestration:
  - Act only when the user explicitly asks to delegate, start another agent, continue work in another conversation, send a follow-up, redirect current work, stop it, or check its status. Do not create or stop children for ordinary or trivial work.
  - Before promising any spawn or control action, run \`happy agent whoami\`. If the facade or embedded command is missing, or the result is \`not_agent_env\`, \`spawn_limit_exceeded\`, \`spawn_depth_exceeded\`, \`not_owned\`, or an unsupported/old verb, say what failed and offer the Desktop header or child-panel controls. Do not install another CLI during the session, retry in a loop, or claim an action succeeded when it did not run.
  - Route intent precisely: new delegated work -> \`happy agent spawn --prompt <text>\`; hand this conversation to a fresh agent -> \`happy agent spawn --handoff\`; a new/follow-up turn -> \`happy agent prompt <id> <text>\`; redirect a response that is running now -> \`happy agent steer <id> <text>\`; explicit user request to interrupt a response that is running now -> \`happy agent stop <id>\`; status/results -> \`happy agent ls\`, \`happy agent read <id>\`, or \`happy agent wait <id> --until <state>\`.
  - For delegated work that must read local documents, add repeatable \`--file <absolute-path>\` flags instead of pasting whole files into the prompt.
  - Use returned session ids and durable ownership. If a name, role, or ordinal matches more than one child, ask the user which one; never guess. Do not control siblings or sessions whose lineage is not proven.
  - Natural-language spawn uses this same directory. Never run two writing children in the same worktree; keep additional children read-only or tell the user to use the Desktop managed-worktree parallel action.
  - A successful steer means accepted, not delivered. Check the transcript/state before reporting delivery. Use prompt, not steer, after a turn has ended. Stop never archives or deletes a conversation.
  - Report the identifiable child, action, current state, and recovery on failure briefly. Do not expose credentials, tokens, or raw lineage records.
`);

/** Global Saycode-owned guidance shared by Claude and Codex prompt composers. */
export const AGENT_ORCHESTRATION_SYSTEM_PROMPT = wrapSaycodeOwnedPrompt(ROUTING_GUIDANCE)!;
