/**
 * Binds a permission prompt to the turn that raised it, and checks an external answer against
 * that binding (Saycode specs/desktop-messenger-channels — R9).
 *
 * Why this exists rather than matching on the tool-use id alone: the agent state's pending record
 * is `{ tool, arguments, createdAt }` and carries no turn, no request and no runtime. A messenger
 * answer that names only a permission id is therefore indistinguishable from one aimed at a prompt
 * the Desktop user raised seconds earlier in the same session. Correlating after the fact — tool
 * id to a `tool-call-start` envelope's `turn` — was considered and rejected: the ordering of the
 * two is not guaranteed, and the mapper falls back to a fresh id when the provider block has none
 * (`claude/utils/sessionProtocolMapper.ts`), which fails silently rather than loudly.
 *
 * So the binding is recorded where the prompt is created, from state the runtime already holds,
 * and an answer must reproduce **all four** identifiers to be applied. Anything short of that is
 * refused without touching the pending request.
 */

/** Recorded when a permission prompt is raised. Every field is required; a null turn is unbindable. */
export interface ChannelPermissionBinding {
  permissionId: string;
  /** The turn that raised the prompt. */
  turnId: string;
  /** Core's handle for the external request that opened the turn; null for an ordinary in-app turn. */
  channelRequestId: string | null;
  /** Identifies this CLI process, so an answer aimed at a previous run is refused. */
  runtimeId: string;
  /**
   * Whether an external surface may answer this prompt at all.
   *
   * False for a prompt that is not a yes/no — a question, a plan-mode exit, a filesystem-scope
   * widening. Such a prompt is still **bound**, because the turn is genuinely waiting and R8/R9
   * require saying so and pointing at Desktop; binding it is also what lets the withdrawal fire
   * and what makes the refusal explicit rather than "unknown prompt". It is simply never
   * answerable from outside.
   */
  answerable: boolean;
}

/** What an external answer must carry to be considered at all. */
export interface ChannelPermissionAnswerClaim {
  permissionId: string;
  turnId: string;
  channelRequestId: string;
  runtimeId: string;
}

export type ChannelPermissionBindingVerdict =
  | { ok: true }
  | { ok: false; code: ChannelPermissionRefusal };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export type ChannelPermissionRefusal =
  | 'unknown-permission'
  | 'turn-mismatch'
  | 'request-mismatch'
  | 'runtime-mismatch'
  | 'not-channel-owned'
  | 'not-externally-answerable';

/**
 * Whether an external claim may answer this prompt.
 *
 * Deliberately total and side-effect free: the caller consumes the pending request only after this
 * returns ok, so a refused claim cannot leave the prompt half-answered. Order is chosen so the
 * cheapest, least informative refusal comes first — a caller probing ids learns the same thing
 * from every failure.
 */
export function verifyChannelPermissionClaim(
  binding: ChannelPermissionBinding | undefined,
  claim: ChannelPermissionAnswerClaim,
): ChannelPermissionBindingVerdict {
  // Empty identifiers never match anything real; refusing them here means a producer that forgot
  // to set one cannot accidentally satisfy an equality check against another empty field.
  if (!nonEmpty(claim.permissionId) || !nonEmpty(claim.turnId)
    || !nonEmpty(claim.channelRequestId) || !nonEmpty(claim.runtimeId)) {
    return { ok: false, code: 'unknown-permission' };
  }
  if (!binding) return { ok: false, code: 'unknown-permission' };
  if (!nonEmpty(binding.permissionId) || !nonEmpty(binding.turnId) || !nonEmpty(binding.runtimeId)) {
    return { ok: false, code: 'unknown-permission' };
  }
  if (binding.permissionId !== claim.permissionId) return { ok: false, code: 'unknown-permission' };
  // An in-app prompt has no external request, and no external answer may reach it. This is the
  // check that keeps a messenger tap off a prompt the Desktop user is looking at.
  if (binding.channelRequestId === null) return { ok: false, code: 'not-channel-owned' };
  // Published as guidance, never as a choice. A messenger was told this turn is waiting and to
  // go to Desktop; an answer for it is refused before any identifier is compared, so a caller
  // that guessed the handle learns nothing about the turn or the request.
  if (!binding.answerable) return { ok: false, code: 'not-externally-answerable' };
  if (binding.runtimeId !== claim.runtimeId) return { ok: false, code: 'runtime-mismatch' };
  if (binding.turnId !== claim.turnId) return { ok: false, code: 'turn-mismatch' };
  if (binding.channelRequestId !== claim.channelRequestId) return { ok: false, code: 'request-mismatch' };
  return { ok: true };
}

/**
 * Tools whose prompt is not a plain yes/no, and which therefore never get an external two-button
 * approval:
 *
 * - `ExitPlanMode` — approving it switches the session's permission mode even when the answer
 *   omits `mode`, because the handler defaults it to `'default'`.
 * - `AskUserQuestion` / `RequestUserInput` — these want an answer, not consent.
 * - `ProjectFilesystemScope` — approving it widens the agent's filesystem scope, which is a
 *   privilege escalation and outlives the request.
 *
 * Names are normalized the way Desktop's own `isAskUserQuestionToolName`
 * (`src/sync/askUserQuestion.ts`) normalizes them: a provider may present the same tool as
 * `functions.AskUserQuestion`, `mcp__something__AskUserQuestion`, `ask_user_question` or
 * `AskUserQuestion call`, and a literal-alias list silently lets those through.
 */
const NON_BINARY_TOOLS = new Set([
    'askuserquestion',
    'requestuserinput',
    '사용자에게질문',
    'exitplanmode',
    'projectfilesystemscope',
]);

function normalizeToolName(value: string): string {
    return value
        .replace(/^functions\./i, '')
        .replace(/^mcp__.+?__/i, '')
        .replace(/\s+call$/i, '')
        .replace(/[._\-\s]+/g, '')
        .trim()
        .toLowerCase();
}

export function isExternallyAnswerableTool(toolName: unknown): boolean {
    // Fail closed on anything that is not a name we can normalize: an unnameable tool is not one
    // whose prompt we can claim is a yes/no.
    if (typeof toolName !== 'string' || toolName.trim().length === 0) return false;
    return !NON_BINARY_TOOLS.has(normalizeToolName(toolName));
}

export interface ChannelPermissionAnswerShape {
  mode?: unknown;
  allowTools?: unknown;
  updatedInput?: unknown;
  decision?: unknown;
}

/**
 * Strict, fail-closed: this runs on an RPC body, so the TypeScript shape is a description of what
 * a well-behaved caller sends, not a guarantee. `allowTools: "Bash"`, `allowTools: null`, or a
 * `decision` this build does not recognise are all refused rather than read as "no grant" — the
 * cost of a false refusal is a retry, the cost of a false accept is a persistent grant.
 */
export function externalAnswerCarriesPersistentGrant(answer: ChannelPermissionAnswerShape): boolean {
    if (answer.mode !== undefined) return true;
    if (answer.updatedInput !== undefined) return true;
    if (answer.allowTools !== undefined) {
        // Present at all is suspicious; only a literal empty array is treated as "none".
        if (!Array.isArray(answer.allowTools)) return true;
        if (answer.allowTools.length > 0) return true;
    }
    if (answer.decision !== undefined) {
        // Allowlist, not denylist: a future 'approved_for_project' must refuse on this build.
        if (answer.decision !== 'approved' && answer.decision !== 'denied') return true;
    }
    return false;
}
