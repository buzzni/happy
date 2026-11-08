---
기능: cross-machine-agent-delegation
상태: 블록됨 — spec 승인 대기(Desktop·happy Draft PR)
마지막 갱신: 2026-11-08
---

# 다른 작업PC로 위임 — 데몬 위임 lane Context

## 현재 상태 (3~5문장)

spec 세션이 조사와 문서만 마쳤다(구현 없음). 사용자 시나리오·CLI 계약·승인 항목·결정 대기 목록의 정본은 Desktop
`specs/cross-machine-agent-delegation/context.md`다. 이 저장소에는 데몬 쪽(연결 저장소, 위임 lane, `agent-delegation:*` RPC, 자식 metadata, 능력 광고,
오케스트레이션 안내)만 있다. 승인 뒤 구현 세션이 이 브랜치를 이어받아 H1부터 진행한다.

## 핵심 결정 로그 (누적, 최신이 위)

- [2026-11-08] 결정: 위임 spawn은 새 메서드 `agent-delegation:spawn` / 이유: `spawn-happy-session`은 `environmentVariables`·`token`·`happySecret` 등 입력면이 넓어
  다른 PC 키에 열면 B의 env·자격을 A가 정하게 된다 / 기각: 기존 메서드를 위임 lane 허용 목록에 추가.
- [2026-11-08] 결정: 키는 Desktop이 만들고 서버는 모른다 / 이유: `serverLane.ts` 주석·`e2ee-machine-control-boundary` R3가 서버 키에 에이전트 시작을 금지 /
  재검토 조건: owner relay 출시 또는 서버 계정 간 라우팅 도입.
- [2026-11-08] 결정: CLI는 연결 키를 RPC `agent-delegation:targets`로 받는다 / 이유: 데몬 파일 형식을 CLI 계약으로 만들지 않음 / 기각: CLI가 `agent-delegation.json` 직접 읽기.
- [2026-11-08] 사실: 브리프는 "wire·CLI는 happy가 정본"이라 했으나 `happy agent` verb 소스는 Desktop `cli/`다. CLI 계약은 Desktop spec이 정본.

## 시도했으나 실패한 접근 ⚠️

해당 없음.

## 발견된 문제 / 열린 질문

- `stop-session`은 서버 lane에도 열려 있다(`serverLane.ts`). 위임 lane에서는 피어의 위임 자식으로 좁히지만, 같은 핸들러를 공유하므로 구현 시 lane별 대상 제한을 핸들러 밖(lane 판정 직후)에 둘지 결정 필요.
- 위임 동시 상한(D-5)의 "살아 있는 위임 자식" 판정 원천 — 데몬 세션 추적 맵에서 `delegatedFrom`이 있는 항목을 세는 것으로 가정. 구현 시 확인.
- (범위 밖) 메인 체크아웃 `/Users/justin/workspace/happy`는 `feat/resumable-agent-observation`, origin/main보다 516커밋 뒤.

## 다음 세션 시작점

1. Desktop Draft PR의 승인 결과를 spec.md 상단과 결정 로그에 반영.
2. H1: `packages/happy-cli/src/daemon/agentDelegationStore.ts` — 저장 위치는 다른 0600 파일(예: `access.key`)을 쓰는 persistence 헬퍼를 먼저 찾아 재사용.
3. H3 전에 `src/api/rpc/RpcHandlerManager.ts` `openParams`·`sealRefusal`과 `serverLane.ts`를 읽는다 — 거절도 열린 키로 봉인하는 규칙을 그대로 따른다.

## 파일 맵

- `packages/happy-cli/src/api/rpc/RpcHandlerManager.ts` — lane 판정(`openParams`), 거절 봉인
- `packages/happy-cli/src/api/rpc/serverLane.ts` — 허용 목록 선례
- `packages/happy-cli/src/api/apiMachine.ts` — `spawn-happy-session`(:1390), 머신 RPC 등록
- `packages/happy-cli/src/api/types.ts` — `Metadata`(세션), `MachineMetadataSchema`(머신, zod strip 주의)
- `packages/happy-cli/src/prompt/agentOrchestrationPrompt.ts` — 에이전트 안내
- `packages/happy-cli/src/commands/agentCommand.ts` — 묶음 saycode-cli로 전달

## 검증·승인 상태

- 실행한 검증과 결과: 문서 전용 — 인용한 파일·심볼 존재 확인.
- 미실행 검증과 이유: 코드 테스트 없음(구현 없음).
- 승인된 범위·근거: 없음.
- 남은 승인 대상·재개 조건: Desktop 승인 항목 A2·A4, 결정 D-1·D-5·D-6.
