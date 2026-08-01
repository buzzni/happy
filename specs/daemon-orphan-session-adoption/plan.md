# 데몬 고아 세션 입양 Plan

> spec.md의 요구사항을 4개 Phase로 분해. 각 Phase는 독립 커밋·독립 배포 가능.

## 아키텍처 영향 평가

**있음 (소규모).** 데몬 ↔ 세션 로컬 HTTP 프로토콜(`/session-runtime`)에 필드 1개(`hostPid`)를
additive로 추가한다. 새 모듈 `daemon/orphanAdoption.ts`(순수 함수)를 추가하고, 기존
`sessionIdleReaper.ts`의 가드에 입력 1개(`adoptedAt`)를 추가한다. 레이어 경계를 넘는 새 의존성은
없다 — `orphanAdoption.ts`는 `persistence`의 타입만 읽고 I/O는 호출자가 주입한다.

ADR은 쓰지 않는다: 되돌리기 비용이 낮고(필드 1개 + 순수 함수), 대안(ps 스캔)을 기각한 근거는
spec.md의 비목표에 이미 기록했다.

## 설계 결정

### D1. 입양 트리거는 "리포트 수신"이지 "프로세스 스캔"이 아니다
살아있는 세션은 30초마다 자기 sessionId를 들고 찾아온다. 이 신호는 sessionId가 권위 있고,
플랫폼 독립적이며, 프로세스가 살아있다는 증거를 겸한다. 기각한 대안: ps 스캔 (spec 비목표 참조).

### D2. `hostPid`는 보고하는 프로세스가 스스로 신고한다
persisted 저장소의 `metadata.hostPid`를 조회하는 방식은 PID 재사용 위험을 안는다(최대 14일치
기록이 남음). 보고 프로세스가 `process.pid`를 함께 보내면 그 위험이 원천 소멸한다 — 살아서
보고하는 프로세스의 pid는 정의상 그 프로세스의 것이다. 구버전 세션(필드 없음)만 조회 폴백을
쓰고, 그 경로는 `isPidAlive` 검증을 강제한다.

### D3. 유예(grace)는 세 리퍼가 아니라 가드 한 곳에 넣는다
세 리퍼(zombie/empty/idle)는 모두 `mode:'if-idle'`로 `stopSession`을 호출하고, 거기서
`evaluateIdleStopGuard`를 통과해야 한다. 따라서 가드에 `adoptedAt` 입력 하나를 추가하면
세 경로를 한 번에 덮는다. 리퍼 3곳을 각각 고치는 안은 중복이고 누락 위험이 있어 기각.

### D4. Phase 3(상태 스냅샷 복원)은 Phase 1/2와 독립이며 후순위다
구 데몬의 `unlink`는 이미 배포된 코드라 고칠 수 없고, 앞으로 같은 전환이 또 일어날 확률은
낮다(1.1.9 → 포크 전환은 1회성). 반면 Phase 1/2는 상태파일이 사라지는 **모든** 경로
(SIGKILL, OOM, 파일 손상)를 덮는다. 그래서 Phase 3은 재발 방지용 안전망으로 뒤에 둔다.

## Phase 구성

| Phase | 내용 | 커밋 유형 | 상태 |
|---|---|---|---|
| 0 | 사고 호스트 로그로 D1 전제 확증 (`Ignoring runtime report for untracked`) | 없음 | 진행 중 |
| 1 | 런타임 리포트 기반 입양 (R1~R5) | behavioral | 대기 |
| 2 | 기동 시 입양 — 침묵하는 고아 (R6) | behavioral | 대기 |
| 3 | 버전 전환 창 봉인 (R7) | behavioral | 대기 |
| 4 | 관측성 (R8) | behavioral | 대기 |

## 검증

- 각 작업: 해당 유닛 테스트 (`vitest run --project unit`)
- 각 Phase 종료: `pnpm typecheck` + 전체 유닛 스위트
- Phase 1 종료 후 수동 검증: 세션 하나를 띄운 채 데몬을 SIGKILL → 재기동 → 30초 내
  `Adopted orphan session` 로그와 `/list`에 해당 세션이 나타나는지 확인

## 리스크

- **입양된 세션이 곧바로 리핑될 위험**: R3(실제 시작시각) + R4(유예) + 기존 `batchMax`(10)로
  완화. 가드의 `recent-user-interaction`/`local-session`은 R2의 `startedBy` 복원으로 보존된다.
- **Phase 2의 PID 재사용**: 프로세스 시작시각 ≤ `savedAt` 검증으로 방어. 검증 수단이 없는
  플랫폼에서는 입양하지 않는다(안전 실패).
