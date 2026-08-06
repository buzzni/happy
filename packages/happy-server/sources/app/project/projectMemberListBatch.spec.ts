import { describe, it, expect, vi, beforeEach } from "vitest";

// specs/project-members-batch-lookup — 프로젝트마다 한 번씩 도는
// /v1/projects/:id/members 호출이 2026-08-06 P2024 (pool 고갈) 의 1차
// 경로였다. 224개 프로젝트 × 3쿼리 ≈ 672쿼리가 동시에 pool 을 잡았다.

let projectFindManyMock: any;
let memberFindManyMock: any;

vi.mock("@/storage/db", () => ({
    db: {
        get project() {
            return { findMany: projectFindManyMock };
        },
        get projectMember() {
            return { findMany: memberFindManyMock };
        },
    },
}));

import { projectMemberListBatch, MAX_BATCH_PROJECT_IDS } from "./projectMemberListBatch";

function makeCtx(uid: string) {
    return { uid } as any;
}

function account(id: string) {
    return { id, username: `user-${id}`, firstName: null, lastName: null, avatar: null };
}

function project(id: string, ownerId: string) {
    return {
        id,
        accountId: ownerId,
        createdAt: new Date(1_000),
        account: account(ownerId),
    };
}

function member(projectId: string, accountId: string, role = "editor", status = "accepted") {
    return {
        id: `${projectId}:${accountId}`,
        projectId,
        accountId,
        role,
        status,
        createdAt: new Date(2_000),
        account: account(accountId),
    };
}

describe("projectMemberListBatch", () => {
    beforeEach(() => {
        projectFindManyMock = vi.fn().mockResolvedValue([]);
        memberFindManyMock = vi.fn().mockResolvedValue([]);
    });

    // AC1 — 이 한 건이 이 spec 의 존재 이유다.
    it("프로젝트 수와 무관하게 DB 왕복이 2회다", async () => {
        const ids = Array.from({ length: 200 }, (_, i) => `p-${i}`);
        projectFindManyMock.mockResolvedValue(ids.map((id) => project(id, "me")));

        const result = await projectMemberListBatch(makeCtx("me"), ids);

        expect(result.ok).toBe(true);
        expect(projectFindManyMock).toHaveBeenCalledTimes(1);
        expect(memberFindManyMock).toHaveBeenCalledTimes(1);
    });

    // AC4
    it("owner 프로젝트는 implicit owner 행을 맨 앞에 담는다", async () => {
        projectFindManyMock.mockResolvedValue([project("p-1", "me")]);
        memberFindManyMock.mockResolvedValue([member("p-1", "bob")]);

        const result = await projectMemberListBatch(makeCtx("me"), ["p-1"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value["p-1"][0]).toMatchObject({ id: "owner", accountId: "me", role: "owner" });
        expect(result.value["p-1"][1]).toMatchObject({ accountId: "bob", role: "editor" });
    });

    // AC2
    it("caller 가 member 인 프로젝트도 포함한다", async () => {
        projectFindManyMock.mockResolvedValue([project("p-2", "alice")]);
        memberFindManyMock.mockResolvedValue([member("p-2", "me")]);

        const result = await projectMemberListBatch(makeCtx("me"), ["p-2"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.keys(result.value)).toEqual(["p-2"]);
    });

    // AC2 + AC3 — 권한 없는 id 는 배치를 죽이지 않고 생략된다.
    it("owner 도 member 도 아닌 프로젝트는 조용히 생략한다", async () => {
        projectFindManyMock.mockResolvedValue([
            project("p-mine", "me"),
            project("p-theirs", "alice"),
        ]);
        memberFindManyMock.mockResolvedValue([member("p-theirs", "bob")]);

        const result = await projectMemberListBatch(makeCtx("me"), ["p-mine", "p-theirs"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.keys(result.value)).toEqual(["p-mine"]);
    });

    // AC3 — 존재하지 않는 id 도 마찬가지. 존재 여부를 노출하면 안 된다.
    it("존재하지 않는 id 는 권한 없는 id 와 똑같이 생략된다", async () => {
        projectFindManyMock.mockResolvedValue([project("p-1", "me")]);

        const result = await projectMemberListBatch(makeCtx("me"), ["p-1", "p-missing"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.keys(result.value)).toEqual(["p-1"]);
    });

    // AC5
    it("상한을 넘는 id 배열은 거절한다", async () => {
        const ids = Array.from({ length: MAX_BATCH_PROJECT_IDS + 1 }, (_, i) => `p-${i}`);

        const result = await projectMemberListBatch(makeCtx("me"), ids);

        expect(result).toEqual({ ok: false, error: "too-many-ids" });
        expect(projectFindManyMock).not.toHaveBeenCalled();
    });

    // AC6
    it("중복 id 는 한 번만 조회한다", async () => {
        projectFindManyMock.mockResolvedValue([project("p-1", "me")]);

        await projectMemberListBatch(makeCtx("me"), ["p-1", "p-1", "p-1"]);

        const where = projectFindManyMock.mock.calls[0][0].where;
        expect(where.id.in).toEqual(["p-1"]);
    });

    it("빈 배열이면 DB 를 건드리지 않는다", async () => {
        const result = await projectMemberListBatch(makeCtx("me"), []);

        expect(result).toEqual({ ok: true, value: {} });
        expect(projectFindManyMock).not.toHaveBeenCalled();
        expect(memberFindManyMock).not.toHaveBeenCalled();
    });

    // pending 초대도 단건 엔드포인트와 동일하게 노출된다 (멤버 목록은
    // 초대 상태를 보여줘야 한다).
    it("pending 멤버도 status 를 그대로 담는다", async () => {
        projectFindManyMock.mockResolvedValue([project("p-1", "me")]);
        memberFindManyMock.mockResolvedValue([member("p-1", "carol", "viewer", "pending")]);

        const result = await projectMemberListBatch(makeCtx("me"), ["p-1"]);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value["p-1"][1]).toMatchObject({ status: "pending", role: "viewer" });
    });
});
