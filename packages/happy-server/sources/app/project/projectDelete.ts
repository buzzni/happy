import { Context } from "@/context";
import { inTx } from "@/storage/inTx";
import { Result } from "./types";

/**
 * Delete a project.
 * Only the owner can delete. Default projects cannot be deleted.
 */
export async function projectDelete(ctx: Context, projectId: string): Promise<Result<true>> {
    return inTx(async (tx) => {
        const project = await tx.project.findUnique({ where: { id: projectId } });
        if (!project) {
            return { ok: false, error: 'project-not-found' };
        }
        if (project.accountId !== ctx.uid) {
            return { ok: false, error: 'not-owner' };
        }
        if (project.isDefault) {
            return { ok: false, error: 'cannot-delete-default' };
        }

        const automations = await tx.automation.findMany({
            where: { projectId, deletedAt: null, machineAccountId: { not: null }, machineId: { not: null } },
            select: { id: true, revision: true, generation: true, machineAccountId: true, machineId: true },
        });
        if (automations.length > 0) {
            await tx.automationChange.createMany({
                data: automations.map((automation) => ({
                    automationId: automation.id,
                    revision: automation.revision + 1,
                    generation: automation.generation + 1,
                    machineAccountId: automation.machineAccountId!,
                    machineId: automation.machineId!,
                    kind: 'TOMBSTONE' as const,
                })),
            });
        }
        await tx.project.delete({ where: { id: projectId } });
        return { ok: true, value: true };
    });
}
