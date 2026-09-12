import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { ProjectMemberInfo, ProjectRole, Result } from "./types";
import { buildMemberInfo } from "./projectMemberList";
import { getProjectAsOwner } from "./projectAccessCheck";
import { invalidateSessionFollowups } from "@/app/automation/sessionFollowupInvalidationService";

/**
 * Update a project member's role.
 * Only the project owner can change roles.
 */
export async function projectMemberUpdate(
    ctx: Context,
    projectId: string,
    memberId: string,
    role: ProjectRole
): Promise<Result<ProjectMemberInfo>> {
    return await inTx(async (tx) => {
        const projectResult = await getProjectAsOwner(tx, projectId, ctx.uid);
        if (!projectResult.ok) {
            return projectResult;
        }

        const member = await tx.projectMember.findUnique({
            where: { id: memberId }
        });
        if (!member || member.projectId !== projectId) {
            return { ok: false, error: 'member-not-found' };
        }

        if (role === 'viewer' && member.role !== 'viewer') {
            await invalidateSessionFollowups(
                tx,
                { projectId, ownerAccountId: member.accountId },
                'PERMISSION_REVOKED',
            );
        }

        const updated = await tx.projectMember.update({
            where: { id: memberId },
            data: { role },
            include: { account: true }
        });

        return { ok: true, value: buildMemberInfo(updated, updated.account) };
    });
}
