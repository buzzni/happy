import { Project } from "@prisma/client";

type Tx = {
    project: { findUnique: Function };
    projectMember: { findUnique: Function };
};

/**
 * Check if a user has at least the given role on a project.
 * The project creator (accountId) is always treated as owner.
 */
export async function hasProjectRole(
    tx: Tx,
    projectId: string,
    userId: string,
    requiredRole: 'owner' | 'editor' | 'viewer'
): Promise<boolean> {
    const project = await tx.project.findUnique({ where: { id: projectId } });
    if (!project) {
        return false;
    }

    // Project creator is always owner
    if (project.accountId === userId) {
        return true;
    }

    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: userId } }
    });
    if (!member) {
        return false;
    }

    return roleAtLeast(member.role, requiredRole);
}

/**
 * Load project and verify caller is owner.
 * Returns the project if authorized, null otherwise.
 */
export async function getProjectAsOwner(
    tx: Tx,
    projectId: string,
    userId: string
): Promise<Project | null> {
    const project = await tx.project.findUnique({ where: { id: projectId } }) as Project | null;
    if (!project) {
        return null;
    }

    if (project.accountId === userId) {
        return project;
    }

    const member = await tx.projectMember.findUnique({
        where: { projectId_accountId: { projectId, accountId: userId } }
    });
    if (member?.role === 'owner') {
        return project;
    }

    return null;
}

const ROLE_LEVEL: Record<string, number> = { viewer: 0, editor: 1, owner: 2 };

function roleAtLeast(actual: string, required: string): boolean {
    return (ROLE_LEVEL[actual] ?? -1) >= (ROLE_LEVEL[required] ?? 99);
}
