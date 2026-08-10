import { describe, it, expect, vi, beforeEach } from "vitest";

// specs/machine-active-recovery AC3/AC4 — 소켓 연결/끊김의 DB 반영은
// 대칭이어야 한다. 예전에는 끊김만 영속화되고 연결은 ephemeral
// 브로드캐스트만 있어서, 재연결한 머신이 DB 상 offline 로 남았다.

let updateManyMock: any;
let logMock: any;

vi.mock("@/storage/db", () => ({
    db: {
        get machine() {
            return { updateMany: updateManyMock };
        },
    },
}));

vi.mock("@/utils/log", () => ({
    log: (...args: any[]) => logMock(...args),
}));

import { markMachineOffline, markMachineOnline } from "./machinePresence";

describe("machinePresence", () => {
    beforeEach(() => {
        updateManyMock = vi.fn().mockResolvedValue({ count: 1 });
        logMock = vi.fn();
    });

    it("연결 시 active=true 와 lastActiveAt 을 기록한다", async () => {
        await markMachineOnline("user-1", "mach-1", 1700);

        expect(updateManyMock).toHaveBeenCalledTimes(1);
        const arg = updateManyMock.mock.calls[0][0];
        expect(arg.where).toMatchObject({ id: "mach-1", accountId: "user-1" });
        expect(arg.data).toMatchObject({ active: true });
        expect(arg.data.lastActiveAt).toEqual(new Date(1700));
    });

    // 끊김 경로는 `active: true` 인 행만 건드려 이미 꺼진 머신에 불필요한
    // 쓰기를 하지 않는다. 켜는 쪽은 그 대칭이 아니다 — active=false 인
    // 행이야말로 되살려야 할 대상이므로 where 에 active 조건을 넣으면
    // 안 된다.
    it("연결 시 where 절이 현재 active 값으로 대상을 좁히지 않는다", async () => {
        await markMachineOnline("user-1", "mach-1", 1700);

        const arg = updateManyMock.mock.calls[0][0];
        expect(arg.where).not.toHaveProperty("active");
    });

    it("끊김 시 active=false 와 lastActiveAt 을 기록한다", async () => {
        await markMachineOffline("user-1", "mach-1", 2500);

        const arg = updateManyMock.mock.calls[0][0];
        expect(arg.where).toMatchObject({ id: "mach-1", accountId: "user-1", active: true });
        expect(arg.data).toMatchObject({ active: false });
        expect(arg.data.lastActiveAt).toEqual(new Date(2500));
    });

    // 재연결 레이스: hasMachineSocket 확인과 UPDATE 사이에 새 소켓이 붙어
    // markMachineOnline 이 먼저 커밋되면, 뒤늦게 도착한 offline 쓰기가
    // 살아 있는 머신을 꺼버린다. lastActiveAt 가드가 그걸 막는다.
    it("끊김 쓰기는 더 최신 활동을 덮어쓰지 않는다", async () => {
        await markMachineOffline("user-1", "mach-1", 2500);

        const where = updateManyMock.mock.calls[0][0].where;
        expect(where.lastActiveAt).toEqual({ lte: new Date(2500) });
    });

    // AC4 — DB 가 흔들려도 소켓 수명주기를 깨면 안 된다. 2026-08-06 처럼
    // pool 이 고갈된 순간에 연결까지 끊기면 장애가 증폭된다.
    it("DB 실패가 호출자에게 전파되지 않고 로그만 남는다", async () => {
        updateManyMock = vi.fn().mockRejectedValue(new Error("P2024 pool timeout"));

        await expect(markMachineOnline("user-1", "mach-1", 1700)).resolves.toBeUndefined();
        expect(logMock).toHaveBeenCalled();
        const logged = JSON.stringify(logMock.mock.calls);
        expect(logged).toContain("P2024");
    });

    it("끊김 경로의 DB 실패도 전파되지 않는다", async () => {
        updateManyMock = vi.fn().mockRejectedValue(new Error("connection reset"));

        await expect(markMachineOffline("user-1", "mach-1", 2500)).resolves.toBeUndefined();
        expect(logMock).toHaveBeenCalled();
    });
});
