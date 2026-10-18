# 재개 가능한 세션 관측 계약 v1

메시지 소비자가 고정 기준점 이후를 누락 없이 조회하려면 `Session.seq` 증가와 메시지 삽입이 같은 transaction에서 commit되어야 한다.
socket writer는 REST/automation writer와 같이 이 경계를 지킨다. account update seq의 원자성·전송 순서는 이 계약의 대상이 아니다.

## 활성화와 롤백

- 기본은 비활성이다. DB migration이나 기존 GET 응답 변경은 없다.
- **모든 구 writer를 drain한 뒤에만** 모든 관측 서버에 같은 `HAPPY_OBSERVATION_COHORT`를 설정한다.
  값은 영문·숫자·점·밑줄·하이픈 1~128자다. rolling deploy 중에는 설정하지 않는다.
- cohort는 운영자가 소유하는 관측 세대다. DB restore/import, retention 정책 변경 또는 보장을 무효화하는 writer 교체 시 새 값으로 바꾼다.
- writer 수정 rollback 전에 모든 서버에서 cohort를 제거해 기능 광고와 opt-in 조회를 끈다. 기존 GET/POST는 그대로 동작한다.
- 이 문서는 배포 승인이나 설정 변경을 실행하지 않는다.

## Wire

인증된 `GET /v3/session-observation`은 `resumableObservation`을 반환한다.
비활성은 null이며 활성은 `{version:1,maxPageSize:200,contract:'committed-session-history-v1'}`다.

기존 session ownership/grant 경계를 사용하는
`GET /v3/sessions/:id/messages?observation_version=1&after_seq=N&through_seq=M&limit=K`는
`(N,M]`을 오름차순으로 조회한다. M 생략 시 transaction snapshot의 committed session seq를 사용한다.
K는 1~200이며 `before_seq`와 혼용할 수 없다. limit+1 lookahead는 커서에서 제외한다.

repeatable-read snapshot에서 세션·상한·행을 읽고 응답에는 다음 근거를 포함한다.

- `observation`: version, generation, coveredThroughSeq, observedAt, retention=full, contract, responseFinality=unknown.
- `contentRevision`: 현재 암호문 JSON의 SHA-256 digest. 순서가 있는 revision 번호나 평문 finality가 아니다.
- generation: cohort·session ID·createdAt·암호화 헤더의 digest. ciphertext-only rewrap은 행 revision만 바뀔 수 있다.
  소비자는 미확정 행을 재조회해야 하며 헤더가 같다는 이유로 본문 불변을 가정하지 않는다.
- 응답 전체 512KiB 초과는 413, 미래/역행 상한은 409, 미소유/삭제 대상은 404, 비활성은 503이다.
- 현재 개별 행 삭제 경로는 없으며 세션 삭제는 전체를 삭제한다. seq 숫자의 연속성을 완전성 근거로 사용하지 않는다.

## 검증과 한계

PGlite 통합 검증은 삽입 전 writer transaction을 멈춘 상태에서 새 상한이 보이지 않음을 확인한다.
함께 확인하는 경계는 capability 비활성, 고정 상한/페이지, 동일 seq 갱신 digest, 암호화 헤더 변경,
타 계정/기존 GET 호환성 및 socket transaction 배치다. 운영 DB·실제 rolling deployment 수락은 별도다.
서버는 E2EE 본문을 해독하지 않으며 응답 전체 finality와 임의 요청의 작업 성공을 보장하지 않는다.
