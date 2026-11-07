# cli-usage-limits-snapshot — 세션 단위 Claude 요금제 사용량(usage-limits) 스냅샷

정본: Desktop `specs/happy-upstream-benchmark/spec.md` R8 (작업 H3, 2026-11-07 사용자 승인).
upstream 참고: slopus/happy cf95337b6 `packages/happy-cli/src/claude/utils/usageLimits.ts`, `claudeRemote.ts`의 `flushUsageLimits`, `claudeRemoteLauncher.ts`의 `onUsageLimits`, `api/types.ts`의 `AgentState.usageLimits`. 파일은 그대로 복사하지 않고 포크 구조에 맞게 씁니다.

## 문제

Claude는 실행 중 요금제 한도 정보를 두 경로로 준다.

1. `rate_limit_event`(밀어 줌): 지금 걸리는 창 하나. `utilization`은 0~1 비율, `resetsAt`은 unix 초.
2. `get_usage` 제어 요청(당겨 옴, SDK `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`): 모든 창. `utilization`은 0~100, `resets_at`은 ISO 문자열. API 키·Bedrock·Vertex 세션은 `rate_limits_available: false`.

포크는 `rate_limit_event`를 계정 자동 전환(`setupTokenAccountSwitching`·`setupTokenUsageTracker`)에만 쓰고, 세션 상태에 구조화된 사용량을 올리지 않는다. Desktop은 머신 단위 `/usage` 텍스트를 파싱해 보여 준다(Desktop 소비는 D6, 이 작업 범위 밖).

## 요구사항

- **R8** (정본 그대로) Given Claude `rate_limit_event`와 첫 result의 `get_usage`, When 수신, Then 비율→퍼센트·unix초→ISO로 정규화해 id별 병합한 usage-limits 스냅샷을 세션 상태에 턴당 최대 1회(변화 없으면 생략) 게시한다. 기존 계정 자동 전환 로직은 그대로 동작한다.

### 세부

- **R8-a** 신규 `claude/utils/usageLimits.ts` — 순수 함수(정규화·병합)와 타입.
  - `synthesizeStatus(utilization)`: 숫자가 아니면 `undefined`, `>= 100` → `rejected`, `>= 90` → `allowed_warning`, 그 밖 `allowed`.
  - `windowsFromGetUsage(rate_limits)`: 각 창 id를 그대로 쓰고, `utilization`은 0~100으로 자르며(숫자 아니면 `null`), `resets_at`은 유효한 ISO면 정규화된 ISO(`toISOString`), 아니면 `null`. 상태는 `synthesizeStatus`. `extra_usage`(과금 상태)와 창 모양(`utilization`·`resets_at` 둘 다 없음)이 아닌 항목은 뺀다.
  - `fromRateLimitEvent(info)`: `utilization` 0~1 비율 → 퍼센트(소수 첫째 자리, 0~100으로 자름; `<= 1`일 때만 ×100 — 단위가 이미 퍼센트로 바뀌어도 맞게), `resetsAt` unix 초 → ISO(`>= 1e12`면 이미 ms로 본다; 날짜로 나타낼 수 없는 값은 `null`). `rateLimitType`이 비지 않은 문자열이면 그 id의 창, 아니면 `unbound`(지금 걸린 창이 무엇인지 모름). 모르는 `status`의 이벤트와 `overage`(요금제 밖 지출 — seed의 `extra_usage`와 같이 뺀다) 이벤트는 버린다. 입력 객체를 바꾸지 않는다(R8-c).
  - `mergeUsageLimits(current, patch)`: id별 병합. 같은 id면 새 값이 이기되 새 값의 `utilization`·`resetsAt`이 비면 이전 값을 지킨다(허용 이벤트는 비율 없이 오기 때문). `patch.replace`(get_usage 전체 스냅샷)면 이전 창을 버리고 패치에서 시작한다. `unbound`는 상태·재설정 시각을 알려진 창 중 사용률이 가장 높은 창에 적용하되 그 창의 사용률은 바꾸지 않고(어느 창의 사용률인지 모르며, 바꾸면 재적용 때 다른 창을 고르게 된다), 사용률 있는 창이 없으면 합성 `plan` 창을 한 개만 유지(upsert)하며 사용률도 그 창에 둔다. `current`가 깨졌거나(배열 아님, id 없는 항목) 다른 버전이 쓴 모양이어도 던지지 않고 읽을 수 있는 창만 쓴다. 같은 패치를 두 번 적용해도 결과가 같다(`updateAgentState`가 버전 충돌 때 콜백을 다시 돌림).
  - 시각 필드: 창의 `resetsAt`은 ISO 문자열(R8), 스냅샷의 `capturedAt`은 다른 agentState 필드(`transientRetry.scheduledAt`, `agentGoalStatus.observedAt`)처럼 epoch ms.
- **R8-b** 수집·게시.
  - 수집기(`claude/utils/usageLimitsCollector.ts`)는 query 하나(= `claudeRemote` 한 번 실행) 동안 산다. `rate_limit_event`를 버퍼에 모으고(id별 최신, unbound는 최신 하나), result마다 한 번 비운다. 첫 result에서만 `get_usage`(`skipBehaviors: true`)로 seed하고, 답을 받았으면 창이 하나도 없어도 그 패치는 `replace`다(이전 계정 창을 지운다). 같은 창에 이벤트가 먼저 와 있으면 이벤트가 이기되, 이벤트에 없는 사용률·재설정 시각은 각각 seed 값으로 채운다.
  - 버퍼가 비었으면 게시하지 않는다. 이 query가 지금까지 게시한 패치들의 병합 결과에 새 패치를 더해도 창(id·상태·사용률·재설정 시각)이 같으면 게시하지 않는다(변화 없으면 생략).
  - launcher는 그 세션(`session.client`)에서 가장 최근에 시작한 query의 패치만 게시한다 — launcher를 다시 들어와도(local↔remote) 이어지는 세는 값. 계정 전환이나 모드 전환으로 provider가 다시 뜬 뒤 이전 query의 seed가 늦게 끝나도, 떠난 계정의 창이 새 스냅샷을 덮지 않는다.
  - 비우기는 직렬화한다: seed를 기다리는 중 다음 result가 와도 패치가 섞이거나 순서가 바뀌지 않는다.
  - `get_usage`가 없거나(구 SDK), 던지거나, `rate_limits_available`이 거짓이거나, 10초 안에 답이 없으면 seed 없이 이벤트만 게시한다. 실패는 턴을 막지 않는다(결과 처리는 비우기를 기다리지 않음).
  - 게시: `claudeRemote` 옵션 `onUsageLimits(patch)` → launcher가 `session.client.updateAgentState(current => ({ ...current, usageLimits: mergeUsageLimits(current.usageLimits, patch) }))`. 병합은 콜백 안에서 하므로 버전 충돌 재시도는 최신 상태 위에서 다시 계산된다(기존 `transientRetry` 패턴).
  - 와이어: `api/types.ts`의 `AgentState`에 선택 필드 `usageLimits?: UsageLimits`만 추가한다. 서버는 agentState를 암호문으로 저장하므로 서버 변경 없음. 필드가 없는 구 Desktop·앱은 무시한다. `AgentState`는 happy-wire에 없으므로 happy-wire 변경 없음.
- **R8-c** 계정 자동 전환과 personal fallback은 그대로다. 같은 `rate_limit_event`를 launcher의 `onMessage`(전환)와 `claudeRemote`의 수집기가 각각 읽지만, 수집기는 입력을 바꾸지 않는 순수 정규화만 하고 서로 상태를 공유하지 않는다. `claudeRemote`는 지금처럼 `rate_limit_event`를 `onMessage`로 넘긴다.
- **R8-d** `get_usage` 충돌 없음.
  - seed는 query 하나에 한 번, `skipBehaviors: true`(최근 7일 transcript 스캔 생략)로 부른다 — 곁질문(`claudeSideQuestion.ts`)도 `skip_behaviors: true`로 부른다.
  - 곁질문은 요청 전후 `session.model_usage` 차이로 사용량을 잰다. `get_usage`는 모델을 부르지 않아 그 누적을 바꾸지 않으므로, 두 호출이 겹쳐도 곁질문 계량이 달라지지 않는다. SDK 제어 요청은 request_id로 구분되어 동시에 떠도 서로의 답을 가로채지 않는다.
  - seed는 곁질문 채널(`sideQuestionRequestOf`)을 거치지 않고 SDK 공개(실험) 메서드를 쓴다. 곁질문의 `inFlight`·관측 상태를 건드리지 않는다.
  - 관리 실행(`managedRun`)은 곁질문을 끄지만(두 번째 프롬프트가 되므로) `get_usage`는 프롬프트가 아니라 그대로 둔다.

## 범위 밖

- Desktop 소비(D6, 정본 R13), Codex/Gemini 사용량.
- `rate_limit_info.unifiedWindows`(포크 tracker가 방어적으로 읽는 비공식 필드, SDK 타입에 없음) — 수집하지 않는다. seed가 같은 창을 채운다.
- 계정이 바뀐 직후 seed가 없는 세션(API 키 등)에서 이전 계정 창이 남는 경우 — 계정 전환은 provider를 다시 띄우므로 새 query의 첫 result seed가 `replace`로 지운다. seed가 없으면 이벤트가 같은 id 창을 덮는다.
