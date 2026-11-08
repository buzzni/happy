# 다른 작업PC로 위임 — 데몬 위임 lane Tasks

> plan.md의 각 Phase를 실행 단위로 분해한 체크리스트. **승인 전에는 H0만 완료.** Desktop tasks의 T1이 이 목록 완료를 기다린다.

## 실행 순서 근거 (한 줄)

저장소가 lane의 키 출처이고, lane이 spawn·session-key·stop의 전제라 이 순서다. 보안 경계(H3)를 spawn보다 먼저 고정한다.

## Phase 0: spec

- [x] H0. spec·plan·tasks·context 작성, Draft PR → 검증: 문서 링크·형식 검토

## Phase 1: 저장소·연결 RPC

- [ ] H1. (Red→Green) `daemon/agentDelegationStore.ts`: version 1, 0600 원자적 쓰기, 각 목록 상한 16, 같은 피어 교체 → 검증: store 단위
- [ ] H2. `install-target`·`install-source`·`revoke`·`list`·`targets`, 고객 lane 한정, `list` 키 미포함, `MachineMetadataSchema.agentDelegation` 광고 → 검증: 메서드 단위 + metadata strip 회귀 테스트

## Phase 2: 위임 lane

- [ ] H3. `RpcHandlerManager.openParams` 세 번째 lane(고객 → 서버 → 위임), `delegationLane.ts` 허용 목록, 거절 봉인 → 검증: 등록 메서드 전체 표 테스트, 연결 없음 무변화, 철회 후 열림 실패

## Phase 3: spawn·session-key·stop

- [ ] H4. `agent-delegation:spawn` 입력 검증(디렉터리 존재·깊이·동시 상한) → 검증: 거절 코드 단위
- [ ] H5. spawn 내부 경로 재사용, B가 env 재구성(A의 env·샌드박스 무시), metadata `delegatedFrom`·`createdBy` → 검증: spawn 픽스처 테스트
- [ ] H6. `agent-delegation:session-key`·위임 lane `stop-session` 피어 한정, 불일치는 `session_not_found` → 검증: 단위
- [ ] H7. 데몬 drain/handoff 중 위임 spawn이 기존 거절 경로를 탐 → 검증: 기존 drain 테스트에 위임 케이스

## Phase 4: 안내·핀·PR

- [ ] H8. `agentOrchestrationPrompt.ts` 한 줄(R12), 묶음 saycode-cli 핀(R13, Desktop CLI 릴리스 후) → 검증: 프롬프트 테스트, `pnpm test`
- [ ] H9. 교차 리뷰·PR·리뷰봇·rebase → 검증: PR MERGEABLE·CI 초록 (릴리스는 지휘 세션)

## 승인 필요한 변경 (해당 시)

- [ ] (제안) Desktop Draft PR 승인 항목 A2·A4와 결정 D-1·D-5·D-6 — 이 저장소 구현의 전제
