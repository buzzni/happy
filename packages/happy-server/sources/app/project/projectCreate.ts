import { Context } from "@/context";
import { db } from "@/storage/db";

interface ProjectCreateParams {
    id?: string;
    name: string;
    description?: string;
    color?: string;
    config?: unknown;
    isDefault?: boolean;
}

interface ProjectRecord {
    id: string;
    accountId: string;
    name: string;
    description: string;
    color: string;
    config: unknown;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Create a new project.
 * Idempotent: if id is provided and already exists for the same user, returns existing.
 */
export async function projectCreate(ctx: Context, params: ProjectCreateParams): Promise<ProjectRecord> {
    if (params.id) {
        const existing = await db.project.findUnique({ where: { id: params.id } });
        if (existing && existing.accountId === ctx.uid) {
            return existing;
        }
    }

    return await db.project.create({
        data: {
            ...(params.id ? { id: params.id } : {}),
            accountId: ctx.uid,
            name: params.name,
            description: params.description ?? '',
            color: params.color ?? '#6366f1',
            config: params.config ?? undefined,
            isDefault: params.isDefault ?? false
        }
    });
}
