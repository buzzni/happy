# 다른 작업PC로 위임 — 데몬 위임 lane Plan

> 작성일: 2026-11-08 / 상태: 승인됨(2026-11-08, D-1~D-7 권장안) — 구현 진행
> 근거 문서: [spec.md](./spec.md) · 짝: aplus-dev-studio-desktop `specs/cross-machine-agent-delegation/plan.md`(Core 분류·대안·참고 코드 정본)

## 아키텍처 영향

| 항목 | 내용 |
|------|------|
| 관련 모듈 | `api/rpc/RpcHandlerManager.ts`(세 번째 lane), 새 `api/rpc/delegationLane.ts`(허용 목록), 새 `daemon/agentDelegationStore.ts`(0600 저장소), 새 `daemon/agentDelegationMethods.ts`(RPC), `api/apiMachine.ts`(spawn 내부 경로 재사용·등록), `api/types.ts`(`Metadata.delegatedFrom`, `MachineMetadataSchema.agentDelegation`), `prompt/agentOrchestrationPrompt.ts` |
| 영향받는 소비 경로 | Desktop 작업PC 설정(연결 설치·철회), Desktop `cli/`(targets·spawn·session-key·stop), Desktop 자식 표시(metadata 읽기), 묶음 saycode-cli 핀 |
| 새 외부 의존성 | 없음 (기존 `encrypt`/`tryDecrypt` dataKey 봉인 재사용) |
| 공개 API 변경 | **있음(추가)** — machine-scope RPC 6종, RPC lane 하나, 머신 능력 필드 |
| 데이터 스키마 변경 | **있음(추가)** — 세션 metadata `delegatedFrom`, 머신 metadata `agentDelegation`, happy home `agent-delegation.json`(version 1) |

Core/Extension: **Core** — 권한 집행·비밀 custody·세션 생성 경로를 소유한다(근거는 Desktop plan).

## 접근 방식

서버 lane을 만든 방식(`serverLane.ts`: 별도 키 + 허용 목록 + 거절도 그 키로 봉인)을 그대로 본떠 **위임 lane**을 하나 더 둔다. 키는 서버가 아니라
Desktop이 PC 쌍마다 만들고 두 데몬에 고객 lane RPC로 설치한다. spawn은 `spawn-happy-session`의 내부 함수를 재사용하되 입력을 좁힌 별도 메서드
`agent-delegation:spawn`으로 받는다 — 기존 메서드를 위임 lane에 열면 `environmentVariables`·`token`·`happySecret` 같은 넓은 입력이 따라 열린다.

기각: 서버 lane에 spawn 추가(R3 위반) / `spawn-happy-session` 자체를 위임 lane에 허용(입력면이 너무 넓다) / CLI가 연결 키를 파일에서 직접 읽기
(데몬·CLI 사이에 새 파일 형식 계약이 생김 — RPC `targets`로 대체).

## 단계 (Phases)

- [x] **Phase 1: 저장소·연결 RPC** (R1~R5, R11) → 검증: 저장소 원자적 쓰기·0600·상한, 고객 lane 외 거절, `list`가 키 미포함
- [x] **Phase 2: 위임 lane** (R6, R7, R14) → 검증: 판정 순서, 허용 목록, 거절 봉인 키, 연결 없음 무변화
- [x] **Phase 3: spawn·session-key·stop** (R8~R10) → 검증: 디렉터리·깊이·동시 상한, env 재구성, metadata, 피어 불일치 거절
- [ ] **Phase 4: 안내·핀·PR** (R12, R13) → 검증: 프롬프트 스냅샷, `pnpm test`, PR CI. 릴리스·Desktop pin은 지휘 세션

## 리스크와 대응

- 위임 키 유출 → B 정책 안의 에이전트 시작 권한. 허용 목록을 spawn·읽기 키·위임 자식 stop·상태 조회로 한정, 철회 즉시 메모리에서 제거. 롤백: `agent-delegation.json` 삭제 후 데몬 재시작.
- lane 순서 실수로 고객 요청이 위임 lane으로 열림 → 고객 → 서버 → 위임 순서 고정 테스트.
- 세션 키 반출(R9) → 피어가 만든 위임 자식만, 응답은 위임 키 봉인. 다른 세션은 존재도 알리지 않음.
- 데몬 재시작 중 위임 spawn → 기존 `spawn-happy-session`의 drain/handoff 거절 경로를 그대로 따른다(새 경로 금지).
- 안전성을 좌우하는 가정: "위임 키로 열린 요청은 허용 목록 밖 핸들러에 닿지 않는다" → 확인: 등록된 모든 메서드를 위임 lane으로 호출해 허용 목록 5개만 통과하는 표 테스트.

## 실행 근거와 승인 상태

- 사용자 요청 범위·실행 근거: Desktop 오케스트레이션 Phase 5 T13(spec 세션).
- 승인 필요 여부·이유: 필요 — 데몬 RPC·lane·metadata 추가, 새 신뢰 경로(Desktop 승인 항목 A2·A4).
- 승인받은 사항: 2026-11-08 사용자 — Desktop 승인 항목 A1~A6, 결정 D-1~D-7 권장안.
- 사용자 지정 검토 지점: Desktop·happy Draft PR 승인.
- 보류 범위·재개 조건: 없음(구현 진행). 릴리스·Desktop pin은 지휘 세션.
