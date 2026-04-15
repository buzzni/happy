import { Context } from "@/context";
import { db } from "@/storage/db";

interface ProjectWithMembership {
    id: string;
    accountId: string;
    name: string;
    description: string;
    color: string;
    config: unknown;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
    membership: string;
}

/**
 * List all projects accessible to the user.
 * Includes owned projects and projects where user is an accepted member.
 */
export async function projectList(ctx: Context): Promise<ProjectWithMembership[]> {
    const owned = await db.project.findMany({
        where: { accountId: ctx.uid },
        orderBy: { updatedAt: 'desc' }
    });

    const memberships = await db.projectMember.findMany({
        where: { accountId: ctx.uid, status: 'accepted' },
        include: { project: true }
    });

    return [
        ...owned.map(p => ({ ...p, membership: 'owner' })),
        ...memberships.map(m => ({ ...m.project, membership: m.role }))
    ];
}
