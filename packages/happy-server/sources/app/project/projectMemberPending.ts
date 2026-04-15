import { Context } from "@/context";
import { db } from "@/storage/db";
import { ProjectMemberInfo } from "./types";
import { buildMemberInfo } from "./projectMemberList";

/**
 * List all pending invitations for the current user.
 * Used to show incoming invitation notifications.
 */
export async function projectMemberPending(
    ctx: Context
): Promise<(ProjectMemberInfo & { projectName: string; inviterUsername: string | null })[]> {
    const members = await db.projectMember.findMany({
        where: {
            accountId: ctx.uid,
            status: 'pending'
        },
        include: {
            account: true,
            project: true,
            inviter: true
        },
        orderBy: { createdAt: 'desc' }
    });

    return members.map(m => ({
        ...buildMemberInfo(m, m.account),
        projectName: m.project.name,
        inviterUsername: m.inviter.username
    }));
}
