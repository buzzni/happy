import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

/**
 * Delete a workspace record.
 * Only the workspace creator or project owner can delete.
 * Returns the deleted workspace's branchName for caller to clean up git.
 */
export async function workspaceDelete(
    ctx: Context,
    workspaceId: string
): Promise<Result<{ branchName: string; projectId: string }>> {
    const workspace = await db.workspace.findUnique({
        where: { id: workspaceId },
        include: { project: true }
    });
    if (!workspace) {
        return { ok: false, error: 'workspace-not-found' };
    }

    const isOwnerOrCreator = workspace.accountId === ctx.uid || workspace.project.accountId === ctx.uid;
    if (!isOwnerOrCreator) {
        return { ok: false, error: 'access-denied' };
    }

    await db.workspace.delete({ where: { id: workspaceId } });

    return { ok: true, value: { branchName: workspace.branchName, projectId: workspace.projectId } };
}
