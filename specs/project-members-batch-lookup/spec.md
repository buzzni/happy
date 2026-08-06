# 프로젝트 멤버 조회 fan-out 축소

## 문제

web-ui 의 프로젝트 목록은 프로젝트마다 `GET /v1/projects/:id/members` 를
한 번씩 호출한다. 2026-08-06 장애 당시 계정 하나에 **224개 프로젝트**가
있었고, 한 번의 목록 로드가 224회 요청으로 번졌다.

`projectMemberList` 자체는 호출당 3쿼리다 (project + 접근권한 확인 +
member 목록). 즉 목록 한 번에 **약 672개 쿼리**가 동시에 pool 을 잡는다.
Prisma 기본 pool 이 89 이라 곧바로 P2024 (`Timed out fetching a new
connection from the connection pool`) 로 넘어간다.

happy-server 로그의 분당 3,264건 P2024 가 이 경로에서 나왔다.

## Goal

여러 프로젝트의 멤버를 **한 번의 요청, 상수 개 쿼리**로 조회할 수 있게
한다.

## Acceptance Criteria

### AC1 — 배치 조회는 쿼리 수가 프로젝트 수에 비례하지 않는다

- **Given** N개 프로젝트 id 를 넘기면
- **Then** DB 왕복은 N 과 무관하게 2회다 (project 조회 1 + member 조회 1)

### AC2 — 접근 권한은 프로젝트마다 개별 판정된다

- **Given** 일부는 caller 가 owner, 일부는 member, 일부는 무관한 프로젝트
- **Then** owner 이거나 member 인 프로젝트만 결과에 담긴다
- **And** 단건 엔드포인트(`projectMemberList`)와 같은 판정 규칙이다

### AC3 — 접근 불가 id 는 배치 전체를 실패시키지 않는다

- **Given** 접근 권한 없는 id 가 섞여 있으면
- **Then** 그 id 만 결과에서 빠지고 나머지는 정상 반환된다

> 단건 엔드포인트는 `access-denied` 를 반환하지만, 배치에서 그렇게 하면
> 남의 프로젝트 id 하나가 목록 전체를 죽인다. 존재 여부도 노출하지 않도록
> "없는 id" 와 "권한 없는 id" 를 똑같이 생략으로 처리한다.

### AC4 — owner 는 항상 implicit owner 행으로 포함된다

- 단건 엔드포인트와 동일하게 `id: 'owner'` 행이 맨 앞에 온다.

### AC5 — id 개수에 상한이 있다

- **Given** 상한을 넘는 id 배열이 오면
- **Then** `too-many-ids` 로 거절한다

> 상한이 없으면 이 엔드포인트 자체가 새로운 pool 고갈 벡터가 된다.

### AC6 — 중복 id 는 한 번만 조회된다

## 비목표

- 단건 `GET /v1/projects/:id/members` 제거. 기존 소비자를 위해 유지한다.
- web-ui 호출부 전환. 이 spec 은 서버 측 엔드포인트까지다 —
  aplus-dev-studio 쪽 `projectMemberClient` 가 이걸 쓰도록 바꾸는 것은
  별도 작업이며, 그 전까지 fan-out 은 그대로 남는다.
