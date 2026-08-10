import { db } from "@/storage/db";
import { log } from "@/utils/log";

/**
 * machine-scoped 소켓의 연결/끊김을 DB 에 반영한다.
 *
 * 두 방향을 한 모듈에 둔 이유는 **대칭을 강제하기 위해서**다. 예전에는
 * 끊김만 `active: false` 로 영속화하고 연결은 ephemeral 브로드캐스트만
 * 했다. `active` 를 다시 true 로 되돌리는 주기적 경로가 없어서, 데몬이
 * 재연결해도 DB 는 offline 인 채로 남았다 (web-ui 는 `online: m.active`
 * 로 매핑하므로 터미널/프리뷰/composer 가 전부 막힌 채였다).
 *
 * specs/machine-active-recovery
 */

/** 두 경로 모두 소켓 수명주기를 깨지 않는다 — DB 실패는 로그로만 남긴다. */
async function writePresence(
    userId: string,
    machineId: string,
    where: Record<string, unknown>,
    active: boolean,
    at: number,
): Promise<void> {
    try {
        await db.machine.updateMany({
            where,
            data: { active, lastActiveAt: new Date(at) },
        });
    } catch (error) {
        log(
            { module: 'websocket', level: 'error' },
            `Failed to mark machine ${active ? 'online' : 'offline'} (user=${userId} machine=${machineId}): ${error}`,
        );
    }
}

/**
 * 연결 시 online 로 기록한다.
 *
 * where 에 `active` 조건을 넣지 않는 것이 핵심이다 — 되살려야 할 대상이
 * 바로 `active: false` 인 행이기 때문이다. (끊김 경로는 반대로 이미 꺼진
 * 행에 불필요한 쓰기를 하지 않도록 `active: true` 로 좁힌다.)
 */
export async function markMachineOnline(
    userId: string,
    machineId: string,
    at: number = Date.now(),
): Promise<void> {
    await writePresence(userId, machineId, { id: machineId, accountId: userId }, true, at);
}

/**
 * 끊김 시 offline 로 기록한다. 이미 꺼져 있으면 아무것도 하지 않는다.
 *
 * `lastActiveAt <= at` 가드가 재연결 레이스를 막는다. 호출부는 쓰기 전에
 * `hasMachineSocket` 으로 대체 연결을 확인하지만, 그 확인과 실제 UPDATE
 * 사이에 새 소켓이 붙어 `markMachineOnline` 이 먼저 커밋될 수 있다. 가드가
 * 없으면 그 뒤에 도착한 낡은 offline 쓰기가 살아 있는 머신을 꺼버린다
 * (heartbeat flush 가 최대 35초 뒤 되살리지만, 그동안 터미널·프리뷰가 막힌다).
 */
export async function markMachineOffline(
    userId: string,
    machineId: string,
    at: number = Date.now(),
): Promise<void> {
    await writePresence(
        userId,
        machineId,
        {
            id: machineId,
            accountId: userId,
            active: true,
            lastActiveAt: { lte: new Date(at) },
        },
        false,
        at,
    );
}
