import { Context } from "@/context";
import { db } from "@/storage/db";
import { ProjectMemberInfo, ProjectRole, InviteStatus, Result } from "./types";
import { Account, ProjectMember } from "@prisma/client";
import { hasProjectRole } from "./projectAccessCheck";

/**
 * List all members of a project.
 * Any member (including pending) can view the member list.
 * The project creator is always included as implicit owner.
 */
export async function projectMemberList(
    ctx: Context,
    projectId: string
): Promise<Result<ProjectMemberInfo[]>> {
    const project = await db.project.findUnique({
        where: { id: projectId },
        include: { account: true }
    });
    if (!project) {
        return { ok: false, error: 'project-not-found' };
    }

    const hasAccess = project.accountId === ctx.uid
        || await db.projectMember.findUnique({
            where: { projectId_accountId: { projectId, accountId: ctx.uid } }
        });
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const members = await db.projectMember.findMany({
        where: { projectId },
        include: { account: true },
        orderBy: { createdAt: 'asc' }
    });

    const result: ProjectMemberInfo[] = [
        {
            id: 'owner',
            projectId,
            accountId: project.accountId,
            username: project.account.username,
            firstName: project.account.firstName,
            lastName: project.account.lastName,
            avatar: project.account.avatar,
            role: 'owner',
            status: 'accepted',
            createdAt: project.createdAt.getTime()
        },
        ...members.map(m => buildMemberInfo(m, m.account))
    ];

    return { ok: true, value: result };
}

export function buildMemberInfo(member: ProjectMember, account: Account): ProjectMemberInfo {
    return {
        id: member.id,
        projectId: member.projectId,
        accountId: member.accountId,
        username: account.username,
        firstName: account.firstName,
        lastName: account.lastName,
        avatar: account.avatar,
        role: member.role as ProjectRole,
        status: member.status as InviteStatus,
        createdAt: member.createdAt.getTime()
    };
}
