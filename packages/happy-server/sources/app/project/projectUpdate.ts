import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { invalidateSessionFollowups } from "@/app/automation/sessionFollowupInvalidationService";
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
    return inTx(async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId } });
        if (!project) {
            return { ok: false, error: 'project-not-found' };
        }
        if (project.accountId !== ctx.uid) {
            return { ok: false, error: 'not-owner' };
        }

        const target = (config: unknown) => {
            const row = config && typeof config === 'object' ? config as Record<string, unknown> : {};
            return {
                machineId: typeof row.machineId === 'string' ? row.machineId : null,
                workspaceDir: typeof row.workspaceDir === 'string' ? row.workspaceDir : null,
            };
        };
        if (params.config !== undefined) {
            const before = target(project.config);
            const after = target(params.config);
            if (before.machineId !== after.machineId || before.workspaceDir !== after.workspaceDir) {
                await invalidateSessionFollowups(tx, { projectId }, 'TARGET_MISMATCH');
            }
        }
        const updated = await tx.project.update({
            where: { id: projectId },
            data: {
                ...(params.name !== undefined && { name: params.name }),
                ...(params.description !== undefined && { description: params.description }),
                ...(params.color !== undefined && { color: params.color }),
                ...(params.config !== undefined && { config: params.config ?? undefined })
            }
        });

        return { ok: true, value: updated };
    });
}
