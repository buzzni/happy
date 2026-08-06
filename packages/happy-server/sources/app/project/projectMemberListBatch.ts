import { Context } from "@/context";
import { db } from "@/storage/db";
import { ProjectMemberInfo, Result } from "./types";
import { buildMemberInfo } from "./projectMemberList";

/**
 * 여러 프로젝트의 멤버를 한 번에 조회한다.
 *
 * 단건 `projectMemberList` 는 호출당 3쿼리다. 프로젝트가 224개인 계정의
 * 목록 한 번이 약 672쿼리로 번져 Prisma pool (기본 89) 을 고갈시키고
 * P2024 를 분당 수천 건 뿜었다 — 2026-08-06 장애의 1차 경로.
 *
 * 여기서는 프로젝트 수와 무관하게 **2쿼리**로 끝낸다: 프로젝트 일괄 조회
 * + 멤버 일괄 조회. 접근 권한은 그 두 결과만으로 메모리에서 판정한다.
 *
 * specs/project-members-batch-lookup
 */

/**
 * 한 번에 요청할 수 있는 프로젝트 수 상한. 상한이 없으면 이 엔드포인트
 * 자체가 새로운 pool 고갈 벡터가 된다.
 */
export const MAX_BATCH_PROJECT_IDS = 200;

export async function projectMemberListBatch(
    ctx: Context,
    projectIds: string[],
): Promise<Result<Record<string, ProjectMemberInfo[]>>> {
    const ids = Array.from(new Set(projectIds));
    if (ids.length > MAX_BATCH_PROJECT_IDS) {
        return { ok: false, error: 'too-many-ids' };
    }
    if (ids.length === 0) {
        return { ok: true, value: {} };
    }

    const [projects, members] = await Promise.all([
        db.project.findMany({
            where: { id: { in: ids } },
            include: { account: true },
        }),
        db.projectMember.findMany({
            where: { projectId: { in: ids } },
            include: { account: true },
            orderBy: { createdAt: 'asc' },
        }),
    ]);

    const membersByProject = new Map<string, typeof members>();
    for (const m of members) {
        const bucket = membersByProject.get(m.projectId);
        if (bucket) bucket.push(m);
        else membersByProject.set(m.projectId, [m]);
    }

    const result: Record<string, ProjectMemberInfo[]> = {};
    for (const project of projects) {
        const projectMembers = membersByProject.get(project.id) ?? [];
        // 단건 엔드포인트와 같은 판정: owner 이거나 (pending 포함) 멤버.
        const hasAccess = project.accountId === ctx.uid
            || projectMembers.some((m) => m.accountId === ctx.uid);
        // 권한 없는 id 와 존재하지 않는 id 를 똑같이 "생략" 으로 처리한다.
        // 단건처럼 access-denied 를 던지면 남의 id 하나가 목록 전체를
        // 죽이고, 응답 모양이 존재 여부를 노출한다.
        if (!hasAccess) continue;

        result[project.id] = [
            {
                id: 'owner',
                projectId: project.id,
                accountId: project.accountId,
                username: project.account.username,
                firstName: project.account.firstName,
                lastName: project.account.lastName,
                avatar: project.account.avatar,
                role: 'owner',
                status: 'accepted',
                createdAt: project.createdAt.getTime(),
            },
            ...projectMembers.map((m) => buildMemberInfo(m, m.account)),
        ];
    }

    return { ok: true, value: result };
}
