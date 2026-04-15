import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

interface WorkspaceCreateParams {
    name: string;
    branchName: string;
}

interface WorkspaceRecord {
    id: string;
    name: string;
    projectId: string;
    accountId: string;
    branchName: string;
    status: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Create a workspace record for a project.
 * Caller must be at least an editor on the project.
 * Branch name uniqueness is enforced per project.
 */
export async function workspaceCreate(
    ctx: Context,
    projectId: string,
    params: WorkspaceCreateParams
): Promise<Result<WorkspaceRecord>> {
    const hasAccess = await hasProjectRole(db, projectId, ctx.uid, 'editor');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const existing = await db.workspace.findUnique({
        where: { projectId_branchName: { projectId, branchName: params.branchName } }
    });
    if (existing) {
        return { ok: false, error: 'branch-exists' };
    }

    const workspace = await db.workspace.create({
        data: {
            name: params.name,
            projectId,
            accountId: ctx.uid,
            branchName: params.branchName,
            status: 'active'
        }
    });

    return { ok: true, value: workspace };
}
