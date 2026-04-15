import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

/**
 * Get a single project by id.
 * User must be the owner or an accepted member.
 */
export async function projectGet(ctx: Context, projectId: string): Promise<Result<{
    id: string;
    accountId: string;
    name: string;
    description: string;
    color: string;
    config: unknown;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}>> {
    const project = await db.project.findUnique({ where: { id: projectId } });
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

    return { ok: true, value: project };
}
