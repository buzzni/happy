import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";
import { hasProjectRole } from "./projectAccessCheck";

interface WorkspaceInfo {
    id: string;
    name: string;
    projectId: string;
    accountId: string;
    ownerUsername: string | null;
    branchName: string;
    status: string;
    createdAt: number;
    updatedAt: number;
}

/**
 * List all active workspaces for a project.
 * Caller must be at least a viewer on the project.
 */
export async function workspaceList(
    ctx: Context,
    projectId: string
): Promise<Result<WorkspaceInfo[]>> {
    const hasAccess = await hasProjectRole(db, projectId, ctx.uid, 'viewer');
    if (!hasAccess) {
        return { ok: false, error: 'access-denied' };
    }

    const workspaces = await db.workspace.findMany({
        where: { projectId, status: 'active' },
        include: { account: true },
        orderBy: { createdAt: 'desc' }
    });

    return {
        ok: true,
        value: workspaces.map(ws => ({
            id: ws.id,
            name: ws.name,
            projectId: ws.projectId,
            accountId: ws.accountId,
            ownerUsername: ws.account.username,
            branchName: ws.branchName,
            status: ws.status,
            createdAt: ws.createdAt.getTime(),
            updatedAt: ws.updatedAt.getTime()
        }))
    };
}
