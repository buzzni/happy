# 세션 출처(source) metadata 기록 Spec

> 작성일: 2026-10-21 / 상태: 구현 완료(PR 대기)
> 원본 요구사항: aplus-dev-studio-desktop `specs/session-source-metadata/` (Codex CLI 벤치마킹 R7, 추천 #1 — Codex `ThreadSource` 열린 enum 태그)
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 목표

자동화가 만든 대화(예약 자동화·GitHub 트리거·독립 리뷰·메신저 채널 등)를 클라이언트가 기기 로컬 기록이나
경로·프롬프트 휴리스틱 없이 판별하도록, 세션 생성 시점에 암호화 metadata에 `source`를 한 번 기록한다.

## 요구사항

- R1. `spawn-happy-session` RPC가 `sessionSource`를 받으면 형식 검사(`^[a-z][a-z0-9-]{0,31}$`)를 통과한 값만
  `SpawnSessionOptions.sessionSource`로 넘긴다. 형식이 틀리면 버린다(저장하지 않음).
- R2. daemon은 그 값을 `HAPPY_CREATED_BY_SOURCE` env로 러너에 전달한다. 5개 러너는 시작 시 그 env를 한 번 읽고
  지운 뒤(`takeSessionSourceFromEnv`) `createSessionMetadata`의 `source` 옵션으로 넘겨 `metadata.source`로 기록한다.
  값이 없으면 필드 자체가 없다(구버전과 동일). env를 지우므로 세션 셸에서 직접 띄운 `happy`·resume 자식도 물려받지 않는다.
- R3. env 이름은 기존 `HAPPY_CREATED_BY` lineage 접두에 속한다 — 세션이 띄운 자식이나 재사용 런타임이 부모의
  출처를 물려받지 않는다.
- R4. daemon이 직접 만드는 세션도 기록한다: 로컬 예약 자동화 tick = `schedule`, 서버 자동화 실행기 =
  GitHub 트리거면 `github-trigger` 아니면 `schedule`, 채널 host = `channel`(spawn 옵션과 미리 만드는 metadata 둘 다).
  단 review_apply가 요청자 세션을 재개하지 못해 띄우는 대체 작업자는 그 사용자 세션을 대신하므로 기록하지 않는다.
- R5. 재연결은 fresh metadata에 키가 없으므로 기존 값이 유지된다. 세션 복구로 새 세션을 띄울 때는 출처를 넘기지
  않는다 — 사람이 이어서 쓰는 대화를 자동화 실행으로 숨기지 않게(읽는 쪽에서는 미상).
- R6. happy-app `MetadataSchema`가 `source`를 문자열로 선언한다 — 앱의 metadata 재기록이 zod strip으로
  필드를 영구 삭제하지 않게. 모르는 값도 그대로 보존한다(열린 enum). 문자열이 아닌 값은 그 필드만 버리고
  문서 전체 파싱을 실패시키지 않는다.

## 값

`user | schedule | autopilot | github-trigger | review | channel | fanout`, 그 외 미래 값 허용.
읽는 쪽은 모르는 값과 부재를 "미상"으로 다룬다 — `user`로 간주하지 않는다.

## 비목표

- 턴 단위 trigger 태그(병행 T5) — 이 필드는 세션 단위다.
- `happy agent spawn` 자식·메모리 lesson 리뷰 세션 등 Desktop 요구 범위 밖의 생성 경로 태깅.
- happy-app MetadataSchema의 기존 `createdBy` 누락(같은 strip 위험) — 별도 이슈로 보고.
