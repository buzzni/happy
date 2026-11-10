# 다른 작업PC로 위임 — 데몬 위임 lane Spec

> 작성일: 2026-11-08 / 상태: **승인됨(2026-11-08, A1~A6 승인·D-1~D-7 권장안)** — 구현 진행
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지
> 짝 문서: aplus-dev-studio-desktop `specs/cross-machine-agent-delegation/` — 사용자 시나리오·`happy agent` CLI 계약·Desktop 표시·승인 항목 A1~A6·결정 D-1~D-7의 정본.
> 이 문서는 **데몬 쪽**(위임 연결 저장, 위임 lane, `agent-delegation:*` RPC, 자식 metadata·능력 광고, 오케스트레이션 안내)의 정본이다.

## 목표

사람이 Desktop에서 켠 "A→B 위임 연결"이 있을 때만, 출발 PC A의 에이전트가 대상 PC B의 데몬에 자식 세션을 만들고
그 자식을 읽고·멈출 수 있게 한다. B는 자기 정책으로 자식을 돌리고, 연결이 철회되면 즉시 거절한다.

## 배경 — 지금 사실 (happy origin/main `29b922a64`)

- F1. `happy agent`는 `src/commands/agentCommand.ts`가 묶음 `@buzzni/saycode-cli`(소스: Desktop `cli/`)로 넘긴다. CLI 계약은 Desktop spec이 정본이다.
- F2. CLI의 spawn은 로컬 machineId로 `spawn-happy-session`(`src/api/apiMachine.ts:1390`)을 부르고, dataKey PC면 로컬 `access.key`의
  machineKey로 봉인한다. 다른 PC의 키는 없다.
- F3. `RpcHandlerManager.openParams`(`src/api/rpc/RpcHandlerManager.ts`)는 고객 키 → 서버 lane 키 순서로 연다. 서버 lane은
  `SERVER_LANE_METHODS` 허용 목록(`src/api/rpc/serverLane.ts`)만 받으며, 그 주석은 "에이전트를 시작·재개하는 메서드"를 서버 키에 주지 않는다고
  못박는다(aplus-dev-studio `e2ee-machine-control-boundary` R3). legacy PC는 서버 lane이 없다(계정 secret을 서버도 가진다).
- F4. happy-server `rpc-call`(`packages/happy-server/sources/app/api/socket/rpcHandler.ts`)은 `rpc:${userId}:${method}` 같은 계정 방에만 전달한다.
  공유·조직 PC 접근 모델은 서버에 없다.
- F5. 세션 metadata 타입은 `src/api/types.ts` `Metadata`(`createdBy` 등), 머신 metadata는 zod `MachineMetadataSchema`(같은 파일)다.
  zod에 없는 필드는 strip되므로 새 능력 필드는 스키마에 넣어야 남는다.
- F6. 계보는 서버에 없다(`metadata.parentSessionId`는 fork 전용, `src/claude/runClaude.ts`).

## 요구사항

### 위임 연결 저장 (Desktop이 고객 lane으로 설치)

- R1. `agent-delegation:install-target { sourceMachineId, keyId, key(base64 32바이트), createdBy: { accountId, displayName? } }` —
  고객 lane에서만 받는다. B의 happy home `agent-delegation.json`(0600, 원자적 쓰기)의 `asTarget`에 저장한다. 같은 sourceMachineId는 교체(키 회전).
- R2. `agent-delegation:install-source { targetMachineId, keyId, key, name, platform }` — 고객 lane에서만. A의 `asSource`에 저장.
- R3. `agent-delegation:revoke { role: 'target'|'source', peerMachineId }` — 고객 lane에서만. 저장소에서 지우고 메모리 lane 키도 즉시 버린다.
  철회 뒤 그 키로 온 요청은 "열 수 없는 요청"으로 거절된다.
- R4. `agent-delegation:list` — 고객 lane에서만. 연결 목록(피어 id·이름·만든 사람·시각)을 돌려주되 **키는 돌려주지 않는다**.
- R5. `agent-delegation:targets` — 고객 lane에서만(A의 CLI가 자기 machineKey로 호출). `asSource` 목록을 키와 함께 돌려준다 —
  CLI가 B로 보낼 요청을 봉인하는 데 쓰고 메모리에만 둔다. 각 목록 상한 16개.

### 위임 lane (대상 PC B)

- R6. `openParams`는 고객 키 → 서버 lane 키 → **`asTarget`의 각 연결 키** 순서로 연다. 위임 키로 열린 요청은 `lane: 'delegation'`, `peer: sourceMachineId`이며
  응답·거절 모두 그 키로 봉인한다.
- R7. 위임 lane 허용 목록(allowlist, 나중에 추가한 메서드는 검토 전까지 닫힘): `agent-delegation:spawn`, `agent-delegation:session-key`,
  `stop-session`(위임 자식 한정, R10), `ai-credential:status`, `ai-credential:capabilities`. 그 밖은 `DELEGATION_LANE_METHOD_NOT_ALLOWED`.
- R8. `agent-delegation:spawn { parentSessionId, directory, agent, model?, effort?, initialPrompt, outputFormat?, aiAuthSelection?, agent: { depth, maxSpawn, agentId } }`:
  - `directory`는 절대 경로이고 **이미 있는 디렉터리**여야 한다(만들지 않음) → 아니면 `{ code: 'project_not_found' }`.
  - `agent.depth`가 최대 깊이(2)를 넘으면 `spawn_depth_exceeded`.
  - B의 위임 자식 중 살아 있는 수가 B의 동시 상한(D-5: B의 `machineSpawnBudget`)을 넘으면 `target_busy`.
  - 기존 `spawn-happy-session`과 같은 내부 spawn 경로를 쓰되 env는 **B가 만든다**: `SAYCODE_AGENT_ENV=1`, `ROOT=SCOPE=directory`, `DEPTH=agent.depth`,
    `MAX_SPAWN=agent.maxSpawn`(B의 tier 상한으로 다시 자름), `SAYCODE_AGENT_ID`, `SAYCODE_AGENT_DELEGATED_FROM=<peer>`. A가 보낸 그 밖의 env·샌드박스 설정은 받지 않는다.
    샌드박스·도구 정책·조직 Claude 계정 판정은 B의 기본값을 따른다.
  - 자식 metadata에 `delegatedFrom: { machineId: peer, sessionId: parentSessionId }`, `createdBy`는 연결의 `createdBy`(D-6).
  - 성공 `{ sessionId, encryptionVariant }`.
- R9. `agent-delegation:session-key { sessionId }` — 그 세션 metadata `delegatedFrom.machineId == peer`일 때만. dataKey 세션이면 세션 데이터 키를
  (위임 키로 봉인된 응답 안에) 돌려주고, legacy 세션이면 `{ variant: 'legacy' }`만. 아니면 `session_not_found`(존재 비노출).
- R10. 위임 lane의 `stop-session`은 `delegatedFrom.machineId == peer`인 세션에만 동작한다. 아니면 `session_not_found`.

### 제한 relay (A7·A8, 2026-11-10 사용자 승인 — Desktop spec R17~R23이 CLI 계약 정본)

- R16. 위임 lane 허용 목록에 `agent-delegation:relay-sessions`·`relay-read`·`relay-prompt`를 더한다. 세 메서드 모두 요청마다
  (a) 연결이 살아 있고 (b) 이 PC가 그 세션의 키를 갖고 있으며(`sessions.json`, 이 PC의 machineId로 기록된 세션) (c) 그 세션이 요청 PC가 만든
  위임 자식이거나 **이 PC가 서버에 물은 소유 판정**(`/v1/session-ownership/relation`, callerSessionId=요청 세션, machineId=이 PC)이 `own`일 때만 답한다.
  요청 세션 자신은 대상이 아니다. 하나라도 아니면 같은 `session_not_found`(존재 비노출). 긍정 판정은 같은 (연결, 요청 세션, 대상)에 60초만 재사용한다.
  서버 판정은 한 번에 100개(`SESSION_OWNERSHIP_RELATION_MAX_TARGETS`)까지, 목록 한 번에 최대 3번만 묻는다(relation 한도 계정당 분당 120). 목록은 최근 순으로 100개가 차면 멈춘다.
- R17. `relay-sessions { requesterSessionId }` → 닿는 세션 최대 100개 `{ id, directory, title, active, updatedAt, delegated }`(최근 순).
  `relay-read { requesterSessionId, sessionId, limit≤200, beforeSeq? | afterSeq? }` → 서버 메시지 한 페이지를 **이 PC에서 복호화**해
  `{ session: { id, directory, active }, messages: [{ seq, localId, createdAt, content }] }`(오래된 순, 복호화 실패 줄은 뺌). 서버 읽기 실패는 `relay_failed`.
- R18. `relay-prompt { requesterSessionId, sessionId, localId, text }` → 살아 있는 세션에만 사용자 메시지를 세션 키로 암호화해 보낸다
  (`meta.sentFrom: "agent-delegation"`, `meta.delegatedFrom: { machineId: peer, sessionId: requester }`). 살아 있지 않으면 `session_not_running`(재개 없음).
  steer·stop·권한 응답·재개는 relay에 없다. 세션 데이터 키는 여전히 이 PC를 떠나지 않는다(R9).
- R19. 오케스트레이션 안내의 "연결한 PC의 내 대화" 줄(조회·`read`·`wait`·`prompt`만, seq 관찰 대신 일반 `wait`/`read`)은 relay를 쓰는 saycode-cli(0.9.17)를 묶는 핀 갱신에서 함께 넣는다 — 프롬프트 테스트가 묶음 버전과 줄의 유무를 맞춘다.

### 광고·안내

- R11. 위임을 지원하는 데몬은 머신 metadata에 `agentDelegation: { version: 1 }`을 광고한다(`MachineMetadataSchema`에 추가 — 없으면 strip).
- R12. `src/prompt/agentOrchestrationPrompt.ts`에 한 줄: "`whoami`가 `delegation.targets`를 알릴 때만 `spawn --machine <target> --project <path>`로 다른 작업PC에 맡기고,
  실패 코드는 그대로 보고하며 이 PC로 대신 만들지 않는다. 위임으로 태어난 세션은 다시 `--machine`을 쓰지 않는다."
- R13. 묶음 saycode-cli 버전 핀(`package.json`)을 Desktop CLI 구현 릴리스에 맞춰 올린다(릴리스·핀 갱신은 지휘 세션).

### 호환

- R14. 연결이 하나도 없는 데몬의 동작·RPC 응답은 지금과 바이트 단위로 같다(lane 시도는 연결 키가 있을 때만).
- R15. 구 데몬(능력 없음)은 Desktop이 연결을 설치하지 않으므로 영향이 없다. 구 CLI는 `agent-delegation:targets`를 부르지 않는다.

## 비목표 (Non-Goals)

- happy-server 변경 — 같은 계정 `rpc-call`로 충분하다. 다른 sync 계정 간 위임은 서버 방 변경이 필요해 제외.
- 서버 lane 허용 목록 변경 — spawn을 서버 키에 주지 않는다.
- 다중 홉, 원격 터미널·파일 동기화, worktree 생성·handoff 위임, 자식 완료 push(T12).
- 위임 lane으로 bash·파일 읽기·쓰기 RPC 열기.

## 제약

- 보안: 위임 키는 0600 파일과 데몬 메모리에만. 로그에 키·세션 키·프롬프트 원문을 남기지 않는다(메서드 이름·lane·peer id만).
  위임 lane 시도는 연결 키 수(≤16)만큼 복호화를 더 할 뿐 고객·서버 lane 판정 순서를 바꾸지 않는다.
- 성능: 연결 없는 PC는 추가 비용 0, 연결이 있으면 실패 요청당 최대 16회 secretbox open.
- 호환: 능력 플래그로만 노출. 기존 RPC·metadata 필드는 바꾸지 않는다(추가만).

## 완료 기준 (Definition of Done)

- [ ] R1~R15 단위 테스트(`pnpm test` in `packages/happy-cli`): lane 판정 순서, 허용 목록 밖 거절, 철회 후 거절, 피어 불일치 stop/session-key 거절,
      디렉터리 없음·깊이·동시 상한, env 재구성(A가 보낸 env 무시), metadata `delegatedFrom`·`createdBy`, 능력 광고가 strip되지 않음
- [ ] 연결 없는 데몬의 기존 RPC 테스트 무변화
- [ ] happy PR CI 초록, Desktop PR과 상호 참조
