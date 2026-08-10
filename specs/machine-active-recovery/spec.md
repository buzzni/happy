# 재연결한 머신이 offline 로 남는 문제

## 문제

`Machine.active` 를 **끄는 경로는 영속화되는데 켜는 경로는 아니다.**

| 이벤트 | 코드 | DB 쓰기 |
|---|---|---|
| machine-scoped 소켓 **끊김** | `socket.ts:224` | `active: false` ✅ |
| machine-scoped 소켓 **연결** | `socket.ts:178` | 없음 — ephemeral 브로드캐스트만 ❌ |
| `machine-alive` heartbeat | `machineUpdateHandler.ts:42` → `sessionCache` flush | `lastActiveAt` 만 ❌ |
| 10분 무활동 스윕 | `timeout.ts:45` | `active: false` ✅ |

`active` 를 true 로 되돌리는 곳은 `machineUpdateHandler.ts:196`
(`machine-update-metadata` 의 daemonState CAS) 하나뿐인데, 이건 주기적이
아니라 **데몬 상태가 바뀔 때만** 발동한다.

결과: 데몬이 재연결해도 DB 의 `active` 는 false 로 남고, 상태 변경 이벤트가
올 때까지 계속 그렇다.

## 사용자에게 보이는 증상

web-ui 는 `online: m.active` 로 매핑한다 (`sync/index.ts:3074`). `online`
이 false 면 머신은 목록에 보이되 다음이 전부 막힌다.

- 채팅 composer (`composerDisableState` → `kind: 'offline'`)
- 홈 터미널 (`homeTerminalMode.ts:13`)
- 프리뷰 패널 (`PreviewPanel.tsx:2928`)

즉 "머신은 보이는데 아무것도 못 함" 상태가 데몬이 멀쩡한데도 지속된다.

## Goal

heartbeat 만으로 `active` 가 회복되게 하고, 연결 시점에도 즉시 회복되게
한다.

## Acceptance Criteria

### AC1 — machine keepalive flush 가 `active` 를 되살린다

- **Given** `Machine.active = false` 인 머신이 heartbeat 를 보내고
- **When** `activityCache` 가 flush 하면
- **Then** UPDATE 문이 `"active" = true` 를 포함한다

> 이건 **기존 계약을 의도적으로 뒤집는 변경**이다.
> `sessionCache.spec.ts` 의 `expect(sql).not.toMatch(/SET[^W]*"active"/)`
> 가 "active toggling lives in presence/timeout.ts" 를 근거로 이를 금지하고
> 있었다. 그 결정은 세션 브랜치(`"active" = true` 를 세팅한다)와 비대칭이고,
> 켜는 경로가 없다는 사실을 놓쳤다. 테스트와 근거 주석을 함께 뒤집는다.

### AC2 — heartbeat flush 는 여전히 `updatedAt` 을 건드리지 않는다

- `specs/machine-keepalive-bump` 의 원래 불변식은 그대로다. `$executeRaw`
  로 Prisma `@updatedAt` 을 우회하는 구조를 유지한다.

### AC3 — 연결 시점에 즉시 online 로 기록한다

- **Given** machine-scoped 소켓이 연결되면
- **Then** `Machine.active = true`, `lastActiveAt` 이 DB 에 기록된다
- **And** 끊김 경로(`active = false`)와 대칭이다

### AC4 — 연결 시 DB 쓰기가 실패해도 연결은 유지된다

- **Given** DB 가 일시적으로 실패해도
- **Then** 소켓 연결 자체는 끊기지 않고, 에러만 로그로 남는다
- **And** AC1 의 flush 가 최대 35초 안에 (`BATCH_INTERVAL` 5s +
  `UPDATE_THRESHOLD` 30s) 같은 상태를 다시 기록해 자가 치유한다

> AC3 단독으로는 부족한 이유: 2026-08-06 장애처럼 pool 이 고갈된 순간에는
> 연결 시점 단발 쓰기가 그대로 유실된다. AC1 의 반복 flush 가 그걸 메운다.

## 비목표

- `timeout.ts` 의 10분 스윕 로직 변경. 무활동 판정 기준은 그대로 둔다.
- `machineUpdateHandler` 의 daemonState CAS 경로 변경.
