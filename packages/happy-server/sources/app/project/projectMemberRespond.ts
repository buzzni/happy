import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { ProjectMemberInfo, Result } from "./types";
import { buildMemberInfo } from "./projectMemberList";

/**
 * Accept or reject a project invitation.
 * Only the invited user can respond to their own pending invitation.
 */
export async function projectMemberRespond(
    ctx: Context,
    memberId: string,
    response: 'accepted' | 'rejected'
): Promise<Result<ProjectMemberInfo>> {
    return await inTx(async (tx) => {
        const member = await tx.projectMember.findUnique({
            where: { id: memberId },
            include: { account: true }
        });
        if (!member) {
            return { ok: false, error: 'member-not-found' };
        }

        if (member.accountId !== ctx.uid) {
            return { ok: false, error: 'access-denied' };
        }

        if (member.status !== 'pending') {
            return { ok: false, error: 'not-pending' };
        }

        const updated = await tx.projectMember.update({
            where: { id: memberId },
            data: { status: response },
            include: { account: true }
        });

        return { ok: true, value: buildMemberInfo(updated, updated.account) };
    });
}
