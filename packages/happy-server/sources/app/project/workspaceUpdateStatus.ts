import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

type WorkspaceStatus = 'active' | 'merged' | 'closed';

/**
 * Update workspace status.
 * Only the workspace creator or project owner can change status.
 */
export async function workspaceUpdateStatus(
    ctx: Context,
    workspaceId: string,
    status: WorkspaceStatus
): Promise<Result<{ id: string; status: string }>> {
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

    const updated = await db.workspace.update({
        where: { id: workspaceId },
        data: { status }
    });

    return { ok: true, value: { id: updated.id, status: updated.status } };
}
