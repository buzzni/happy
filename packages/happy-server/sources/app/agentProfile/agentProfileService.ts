import type { AgentLaunchProfile, Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

export type AgentProfileInput = {
    name: string;
    agent: string;
    model?: string | null;
    worktreeEnabled: boolean;
    activate?: boolean;
};

export type AgentProfileUpdateInput = Partial<Omit<AgentProfileInput, 'activate'>> & {
    activate?: boolean;
};

export async function listAgentProfiles(tx: Tx, accountId: string): Promise<AgentLaunchProfile[]> {
    return tx.agentLaunchProfile.findMany({
        where: { accountId },
        orderBy: [{ active: 'desc' }, { updatedAt: 'desc' }],
    });
}

export async function createAgentProfile(
    tx: Tx,
    accountId: string,
    input: AgentProfileInput,
): Promise<AgentLaunchProfile> {
    const active = input.activate ?? true;
    if (active) {
        await tx.agentLaunchProfile.updateMany({
            where: { accountId, active: true },
            data: { active: false },
        });
    }
    return tx.agentLaunchProfile.create({
        data: {
            accountId,
            name: input.name,
            agent: input.agent,
            model: input.model ?? null,
            worktreeEnabled: input.worktreeEnabled,
            active,
        },
    });
}

export async function updateAgentProfile(
    tx: Tx,
    accountId: string,
    profileId: string,
    input: AgentProfileUpdateInput,
): Promise<{ ok: true; value: AgentLaunchProfile } | { ok: false; error: 'not-found' }> {
    const current = await tx.agentLaunchProfile.findFirst({
        where: { id: profileId, accountId },
    });
    if (!current) return { ok: false, error: 'not-found' };

    if (input.activate) {
        await tx.agentLaunchProfile.updateMany({
            where: { accountId, active: true, id: { not: profileId } },
            data: { active: false },
        });
    }

    const data: Prisma.AgentLaunchProfileUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.agent !== undefined) data.agent = input.agent;
    if (input.model !== undefined) data.model = input.model;
    if (input.worktreeEnabled !== undefined) data.worktreeEnabled = input.worktreeEnabled;
    if (input.activate !== undefined) data.active = input.activate;

    return {
        ok: true,
        value: await tx.agentLaunchProfile.update({ where: { id: profileId }, data }),
    };
}

export async function deleteAgentProfile(
    tx: Tx,
    accountId: string,
    profileId: string,
): Promise<
    { ok: true; activeProfile: AgentLaunchProfile | null }
    | { ok: false; error: 'not-found' }
> {
    const current = await tx.agentLaunchProfile.findFirst({
        where: { id: profileId, accountId },
    });
    if (!current) return { ok: false, error: 'not-found' };

    await tx.agentLaunchProfile.delete({ where: { id: profileId } });
    if (!current.active) {
        const active = await tx.agentLaunchProfile.findFirst({ where: { accountId, active: true } });
        return { ok: true, activeProfile: active };
    }

    const fallback = await tx.agentLaunchProfile.findFirst({
        where: { accountId },
        orderBy: { updatedAt: 'desc' },
    });
    if (!fallback) return { ok: true, activeProfile: null };

    const activeProfile = await tx.agentLaunchProfile.update({
        where: { id: fallback.id },
        data: { active: true },
    });
    return { ok: true, activeProfile };
}
