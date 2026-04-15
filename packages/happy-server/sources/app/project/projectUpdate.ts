import { Context } from "@/context";
import { db } from "@/storage/db";
import { Result } from "./types";

interface ProjectUpdateParams {
    name?: string;
    description?: string;
    color?: string;
    config?: unknown;
}

/**
 * Update a project's metadata.
 * Only the project owner can update.
 */
export async function projectUpdate(ctx: Context, projectId: string, params: ProjectUpdateParams): Promise<Result<{
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
    if (project.accountId !== ctx.uid) {
        return { ok: false, error: 'not-owner' };
    }

    const updated = await db.project.update({
        where: { id: projectId },
        data: {
            ...(params.name !== undefined && { name: params.name }),
            ...(params.description !== undefined && { description: params.description }),
            ...(params.color !== undefined && { color: params.color }),
            ...(params.config !== undefined && { config: params.config ?? undefined })
        }
    });

    return { ok: true, value: updated };
}
