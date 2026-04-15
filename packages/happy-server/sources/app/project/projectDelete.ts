import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

/**
 * Delete a project.
 * Only the owner can delete. Default projects cannot be deleted.
 */
export async function projectDelete(ctx: Context, projectId: string): Promise<Result<true>> {
    const project = await db.project.findUnique({ where: { id: projectId } });
    if (!project) {
        return { ok: false, error: 'project-not-found' };
    }
    if (project.accountId !== ctx.uid) {
        return { ok: false, error: 'not-owner' };
    }
    if (project.isDefault) {
        return { ok: false, error: 'cannot-delete-default' };
    }

    await db.project.delete({ where: { id: projectId } });
    return { ok: true, value: true };
}
