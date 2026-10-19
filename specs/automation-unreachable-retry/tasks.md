# Tasks

- [x] 계약 조사: 서버 claim 창·report 규칙·heartbeat lease, Desktop 자동 일시정지·이력 표시, 관련 spec(R9/R10, turn-fallback)
- [x] [structural] 대기 보고 파서 분리
- [x] 실행기 경계 실패 테스트(보류·재개·3회 후 1회 기록·정규 실행 우선·재시작·일시정지·즉시 실행·대화)
- [x] 보류 run 저장 필드·재시도 모듈·실행기 훅
- [x] 사전 단계 연결성 분류(실제 소켓) 테스트와 구현
- [x] 셀프 리뷰 반영(due 상태에서도 heartbeat, 저장소 이중 읽기 제거, 재시도 로그)
- [x] 관련 vitest·tsc
- [x] 교차 리뷰(오케스트레이터, codex) — 4건
- [x] 사용자 결정으로 축소: 재시도 5·15·30분 → lease 안 약 1·2·4분(서버 lease 만료 시각에서 계산), VPN 지연 시나리오 테스트
- [x] 교차 리뷰 #2: 영구 거절 보고(run-not-running·claim-not-found) 정리, 뒤 보고 막지 않음
- [x] 교차 리뷰 #3: 보류 run 마감 확인 전에는 정규 회차 claim 보류(releasing)
- [x] 교차 리뷰 #4: 재시도 뒤 실패의 failureCode 에 횟수(`_AFTER_<n>_RETRIES`)
- [x] PR #857·CI 통과, main 머지(2026-10-17), happy-cli `1.1.10-aplus.339` 발행에 포함
- [ ] (릴리스 후 실측) 실기기 확인: VPN 전용 Studio 주소에서 깨어난 직후 예약 실행이 1~2분 뒤 같은 run 으로 성공하는지
