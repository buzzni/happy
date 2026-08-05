# Readiness Probe Decoupling

## 배경 (결함)

2026-08-05 06:17~06:35 KST, happy-server(dev)가 10분간 전면 접속 불가였다.

근본 원인은 Ceph osd.19 세션 플랩으로 인한 Postgres I/O 스톨이었으나,
**부분 열화가 전면 장애로 증폭된 경로는 `/ready`였다**:

```
Postgres I/O 스톨 → Prisma 커넥션 풀 고갈
  → /ready 의 SELECT 1 이 같은 풀을 쓰므로 함께 지연/실패
  → readinessProbe 실패(5s×4) → Service endpoint 에서 파드 제거
  → 단일 replica 이므로 전면 차단 (DB 를 쓰지 않는 요청까지 모두)
```

즉 DB 가 느려졌을 뿐인데 서버 전체가 트래픽에서 빠졌다.

## 목표

**공유 의존성(DB)의 열화가 프로세스의 트래픽 수신 자격을 박탈하지 않게 한다.**

- `/ready` (k8s readinessProbe): 프로세스가 요청을 받을 수 있는지만 판단. DB 를 보지 않는다.
- `/health` (모니터링/알림용): DB 연결을 포함한 심층 점검. 실패 시 503.
- `/live` (k8s livenessProbe): 기존과 동일, DB 무관.

## 불변 요구사항

1. `/ready` 는 DB 가 완전히 죽어 있어도 200 을 반환한다.
2. `/ready` 는 DB 를 조회하지 않는다 (커넥션 풀을 소비하지 않는다).
3. `/health` 는 DB 를 조회하고, 실패 시 503 + `error: "Database connectivity failed"` 를 반환한다.
4. `/live` 는 DB 를 조회하지 않는다.
5. 세 엔드포인트의 성공 응답 형태(`status`, `timestamp`, `service`)는 유지한다.

## 비목표

- 알림/모니터링 설정 변경 (별도로 k8s-manifests 에서 처리됨)
- Prisma 풀 파라미터 튜닝 (`socket_timeout` 등은 별건)
- replica 수 / PDB (별건)

## 트레이드오프 (의도된 것)

DB 가 죽어도 파드가 endpoint 에 남으므로, DB 의존 요청은 200 이 아니라
**애플리케이션 레벨 에러**로 실패한다. 이는 의도된 것이다 — DB 무관 경로
(정적 응답, 헬스, 일부 캐시 응답)는 계속 서비스되고, 장애 감지는 probe 가
아니라 `/health` 기반 알림이 담당한다.
