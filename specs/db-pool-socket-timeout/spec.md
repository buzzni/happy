# DB Pool Socket Timeout

## 배경

2026-08-05 장애에서 Postgres I/O 가 스톨하자 Prisma 커넥션 풀(50개)이
전부 busy 상태로 묶였고, 쿼리는 응답 없는 소켓에서 무한 대기했다.
DATABASE_URL 에는 `connection_limit` 과 `pool_timeout` 만 있어
**개별 쿼리의 상한이 없었다**.

## 목표

앱이 쓰는 커넥션 풀에만 `socket_timeout` 을 적용해, 응답 없는 소켓의
쿼리를 정해진 시간에 실패시키고 커넥션을 회수한다.

## 왜 DATABASE_URL 이 아니라 코드인가 (중요)

컨테이너 CMD 가 **같은 `DATABASE_URL` 로 `prisma migrate deploy` 를 먼저
실행**한다 (Dockerfile.server / Dockerfile.server.slim).

```
CMD prisma migrate deploy ... && exec ... start
```

`SessionEvent` 는 이미 1.6GB 다. 인덱스 생성 같은 마이그레이션은 수십 초가
걸릴 수 있는데, URL 에 `socket_timeout=10` 을 넣으면 그 마이그레이션이
중간에 끊긴다. 실패한 마이그레이션은 이후 모든 배포를 막고 수동 복구를
요구한다.

따라서 타임아웃은 **앱의 PrismaClient 를 만들 때만** 주입한다.
마이그레이션은 타임아웃 없는 원본 URL 을 그대로 쓴다.

## 요구사항

1. `DATABASE_URL` 에 `socket_timeout` 이 없으면 앱 풀에만 추가한다.
2. 이미 `socket_timeout` 이 지정돼 있으면 **그 값을 존중한다** (운영자 우선).
3. 기존 쿼리 파라미터(`connection_limit`, `pool_timeout` 등)를 보존한다.
4. `DATABASE_URL` 이 없으면 아무것도 하지 않는다 (Prisma 기본 동작 유지).
5. `DB_PROVIDER=pglite` 경로는 영향받지 않는다.

## 값 선택

기본 30초. 정상 쿼리 p99 는 5ms 수준이라 30초는 순수하게 "죽은 소켓"만
걸러낸다. 10초는 배치 flush 나 큰 조회에서 오탐 위험이 있어 보수적으로
잡았다. `DATABASE_SOCKET_TIMEOUT_SECONDS` 로 재정의할 수 있다.

## 비목표

- 마이그레이션 타임아웃 (의도적으로 제외)
- `connection_limit` / `pool_timeout` 조정 (k8s 매니페스트에서 관리)
