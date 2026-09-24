import type { SessionEvent } from '@slopus/happy-wire';

import type { ChannelPermissionBinding } from '@/channel/channelPermissionBinding';

/**
 * The only thing a messenger surface is told about a permission prompt
 * (Saycode specs/desktop-messenger-channels — R8/R9/R14).
 *
 * Identity only. The tool name, its arguments and its risk class all stay inside the runtime: the
 * agent state's pending record is `{ tool, arguments, createdAt }` and `arguments` is the tool
 * input in full — a shell command line, a file's new contents, a URL. That record reaches every
 * client because the app renders prompts from it, so an external event derived from it would put
 * all of that in a chat message. Here the input is not summarised, truncated or redacted: it is
 * never read.
 *
 * `kind` is the one bit of interpretation, and it is decided when the prompt is bound rather than
 * here:
 *
 * - `generic` — a yes/no the messenger may answer once.
 * - `desktop-only` — the turn is waiting on a prompt that is not a yes/no. R8 requires the
 *   approval-wait state to be distinguishable and R9 requires pointing at Desktop, so this is
 *   published; it is never answerable, and `verifyChannelPermissionClaim` refuses every claim for
 *   it. Publishing nothing at all was the bug: an externally-started turn that hit
 *   `AskUserQuestion` or `ExitPlanMode` stalled with the messenger told nothing.
 *
 * Returns null rather than a partial observation, in three cases:
 *
 * - **No external request.** An in-app prompt is the Desktop user's; publishing it would invite an
 *   answer — or a hand-off instruction — aimed at someone who is not looking at it.
 * - **An incomplete binding.** An empty identifier matches nothing real.
 * - **A binding for a tool Core could not name.** That is the one case with no honest `kind`: we
 *   cannot claim it is a yes/no, and we cannot claim it is not. `bindChannelPermission` refuses to
 *   bind those at all, so they never reach here.
 */
export interface ChannelApprovalObservation {
    permissionId: string;
    turnId: string;
    channelRequestId: string;
    runtimeId: string;
    kind: 'generic' | 'desktop-only';
}

export type ChannelApprovalWithdrawalReason = 'answered' | 'aborted' | 'reset';

function nonEmpty(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Takes the binding alone. The classification lives on the binding because it is decided once,
 * where the tool name is known — reading a tool name again here would mean the raise path and the
 * withdrawal path could disagree about what a prompt was.
 */
export function buildChannelApprovalObservation(
    binding: ChannelPermissionBinding | undefined,
): ChannelApprovalObservation | null {
    if (!binding) return null;
    if (!nonEmpty(binding.channelRequestId)) return null;
    if (!nonEmpty(binding.permissionId) || !nonEmpty(binding.turnId) || !nonEmpty(binding.runtimeId)) {
        return null;
    }
    // Field by field. Spreading the binding would carry anything it gains later into an external
    // message without this file changing.
    return {
        permissionId: binding.permissionId,
        turnId: binding.turnId,
        channelRequestId: binding.channelRequestId,
        runtimeId: binding.runtimeId,
        kind: binding.answerable ? 'generic' : 'desktop-only',
    };
}

/** The wire event for an observation. Separate so the shape above can be unit-tested alone. */
export function channelApprovalEvent(
    observation: ChannelApprovalObservation,
    createdAt: number,
): SessionEvent {
    return {
        t: 'channel-permission',
        permissionId: observation.permissionId,
        turnId: observation.turnId,
        channelRequestId: observation.channelRequestId,
        runtimeId: observation.runtimeId,
        kind: observation.kind,
        createdAt,
    };
}

/**
 * The prompt is no longer answerable from outside — or, for a `desktop-only` one, no longer
 * waiting.
 *
 * Built from the binding that is about to be dropped, so it names the same prompt the observation
 * did. `reason` says which path it left by and nothing about the decision — "answered" does not
 * reveal approved or denied, because the surface that answered may not be the one that asked.
 *
 * `kind` is deliberately **not** carried: the withdrawal's job is to retract a prompt the consumer
 * already has, and it is matched by `permissionId`. Re-stating the kind would be a second place
 * for the two to disagree.
 */
export function channelApprovalWithdrawnEvent(
    observation: ChannelApprovalObservation,
    reason: ChannelApprovalWithdrawalReason,
    createdAt: number,
): SessionEvent {
    return {
        t: 'channel-permission-withdrawn',
        permissionId: observation.permissionId,
        turnId: observation.turnId,
        channelRequestId: observation.channelRequestId,
        runtimeId: observation.runtimeId,
        reason,
        createdAt,
    };
}
