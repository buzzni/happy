# ACP(Grok) 도구 이름 표시 & 채팅 제목 생성

> 작성일: 2026-08-19 / 상태: 승인됨 (사용자 지시 — "grok 에서는 tool 사용이 스크린샷 처럼 제대로 표시가 안되고 있어. 그리고 채팅창 제목도 제대로 생성이 안되고 있어")
> ⚠️ 승인 후에는 사용자 지시 없이 수정 금지

## 배경 (실측)

`grok agent stdio` 를 직접 ACP 로 구동해 캡처한 페이로드:

```jsonc
// 1) 최초 알림 — kind 없음. 이름은 title/_meta 에, 인자는 rawInput 에 있다.
{"sessionUpdate":"tool_call","toolCallId":"call-…-0","title":"read_file",
 "rawInput":{"target_file":"sample.txt"},
 "_meta":{"x.ai/tool":{"name":"read_file","kind":"read","label":"Read"}}}

// 2) 후속 갱신 — kind 와 사람이 읽는 title 이 붙지만 status 가 없다.
{"sessionUpdate":"tool_call_update","toolCallId":"call-…-0","kind":"read",
 "title":"Read `sample.txt`","rawInput":{…},"_meta":{…}}

// 3) 종료 — status 만 있고 kind/title/_meta 는 없다.
{"sessionUpdate":"tool_call_update","toolCallId":"call-…-0","status":"completed","content":[…]}
```

즉 **ACP 규격의 `kind` 는 첫 알림에 오지 않고, `content` 에는 입력 인자가 없다.**
`sessionUpdateHandlers.startToolCall` 은 이 두 가지만 보고 있어서
`toolName: 'unknown'`, `args: {}` 를 내보낸다 (`happy.log`: `Tool call START: … (undefined -> unknown)`).

또한 제목 유도 문구(`change_title` 호출 지시)는 `runClaude.ts` / Codex / Gemini 러너에만 있고,
Grok·OpenCode 가 쓰는 `runAcp.ts` 에는 없다. 실측 로그의 프롬프트 길이는 사용자 원문 그대로였다.
`happy` MCP 서버 자체는 정상이다 — stdio MCP 스텁을 붙여 프로브한 결과 Grok 이
`tools/list` → `tools/call` 을 정상 수행했다. 도구는 있는데 부르라는 지시가 가지 않는 것이 원인이다.

## 요구사항

### A. 도구 이름·인자

- R1. Given `tool_call` 알림에 `_meta["x.ai/tool"].name` 이 있음, When 도구 호출이 시작되면,
  Then 그 이름을 `tool-call` 이벤트의 `toolName` 으로 내보낸다.
- R2. `_meta` 가 없으면 `title` → `extractToolNameFromId(toolCallId)` → `kind` 순으로 이름을 정한다.
  넷 다 없을 때만 `'unknown'` 이다.
- R3. Given `rawInput` 이 비어 있지 않은 객체임, When 도구 호출이 시작되면,
  Then `args` 는 `rawInput` 에서 온다. `rawInput` 이 없거나 비면 기존 `content` 파싱으로 되돌아간다.
- R4. `locations` 는 기존과 동일하게 `args.locations` 로 실린다.
- R5. Given 도구 종료 알림에 `kind` 가 없음(Grok 의 실제 형태), When 완료/실패를 내보내면,
  Then `toolName` 은 시작 시 기록해 둔 이름(`toolCallIdToNameMap`)을 쓴다. 기록이 없을 때만 `'unknown'`.
- R6. `kind` 를 보내는 기존 ACP 에이전트(gemini·opencode)의 동작은 바뀌지 않는다 —
  `_meta`/`title`/`rawInput` 이 없으면 결과가 종전과 동일해야 한다.

### B. 채팅 제목

- R7. Given ACP 세션에 아직 제목이 없음, When 사용자 턴을 에이전트로 보내면,
  Then Claude 백엔드와 동일한 `change_title` 지시 문구를 그 턴 끝에 덧붙인다.
- R8. Given 세션에 이미 제목이 있음, When 턴을 보내면, Then 문구를 덧붙이지 않는다.
- R9. 공백뿐인 턴에는 덧붙이지 않는다(`appendClaudeTitleInstruction` 의 기존 계약).
- R10. 화면에 보이는 사용자 말풍선은 앱이 그리므로 바뀌지 않는다 — 모델에게 가는 사본만 바뀐다.

### C. 데스크탑 표시 (aplus-dev-studio-desktop)

- R11. Grok 도구명이 기존 라벨 체계에 매핑된다: `run_terminal_command`→터미널, `read_file`→읽기,
  `search_replace`→편집, `list_dir`→목록, `task_output`/`kill_task` 등 나머지는 정규화된 원문 표기.
- R12. 경로 인자 추출이 `file_path` / `target_file` 을 인식한다 (Grok 의 read/edit 인자 키).

## 범위 밖 (발견된 문제로만 기록)

- ACP 권한 요청에서 `toolCall.id` 를 읽는데 Grok 은 `toolCallId` 로 보낸다 →
  `randomUUID()` 로 대체되어 권한 카드 id 가 실제 도구 호출과 대응하지 않는다.
- Grok 이 스스로 보내는 `session_info_update.title` 은 계속 "Unhandled" 로 버려진다.
