# context — ACP(Grok) 도구 이름 & 채팅 제목

> 상태: 구현 완료 (로컬 커밋). **미배포** — happy-cli 릴리스 + 데스크탑 핀 갱신 전까지 사용자에게 반영되지 않는다.
> 마지막 갱신: 2026-08-19

## 지금까지

- 브랜치 `fix/acp-grok-tool-name-and-title` (happy)
  - `5a4b4cd2` [structural] `src/claude/utils/titlePrompt.ts` → `src/utils/titlePrompt.ts`,
    `CLAUDE_TITLE_INSTRUCTION`/`appendClaudeTitleInstruction` → `TITLE_INSTRUCTION`/`appendTitleInstruction`
  - `d702a348` [behavioral] `sessionUpdateHandlers` 이름·인자 출처 확장 + `runAcp` 제목 지시
- aplus-dev-studio-desktop `70312167` — Grok 도구명 라벨 매핑, `file_path`/`target_file` 경로 인식

## 어떻게 알아냈나 (재현 가능)

`grok agent stdio` 를 직접 ACP 로 구동하는 프로브를 짜서 raw JSON-RPC 를 받아 적었다.
로그(`~/.happy_remote/logs/*.log`)는 `[large payload omitted in production]` 으로 페이로드를
지우기 때문에 **로그만으로는 원인을 특정할 수 없었다.** 프로브 없이 추측했다면 ACP 규격대로
`kind` 가 올 것이라 믿고 엉뚱한 곳을 고쳤을 것이다.

프로브 스크립트는 세션 스크래치패드에 있었고 저장소에는 넣지 않았다. 핵심은 세 줄이다:
`initialize`(protocolVersion 1) → `session/new`(cwd, mcpServers) → `session/prompt`,
그리고 `session/request_permission` 에 첫 옵션으로 응답.

## 결정과 이유

- **제목: Grok 자체 `session_info_update` 대신 `change_title` 지시.** Grok 은 턴 시작 ~2초 뒤
  스스로 영어 제목을 `session_info_update` 로 보내고 happy 는 그걸 "Unhandled" 로 버린다.
  그걸 주워 쓰는 쪽이 확실하지만 (a) 사용자 언어가 아니고 (b) `branchSlug` 가 없어 worktree
  브랜치명이 다른 에이전트와 달라진다. 사용자가 지시 방식을 선택했다.
- **`toolName` 에 Grok 원래 이름(`run_terminal_command`)을 그대로 싣는다.** ACP `kind`
  (execute/read/edit…)로 정규화하면 카드가 뭉개진다. 표시 라벨은 데스크탑이 이미 에이전트별
  도구명을 매핑하는 계층을 갖고 있으므로 그쪽에서 처리한다.
- **종료 알림에서 `toolCallIdToNameMap` 을 재사용한다.** Grok 의 마지막 `tool_call_update` 에는
  `status`/`content` 만 있고 `kind`·`title`·`_meta` 가 전부 사라진다.

## 시도했으나 아닌 것으로 밝혀진 가설

- "Grok 세션에 happy MCP 서버가 안 붙는다" — 아니다. stdio MCP 스텁을 붙여 프로브한 결과
  Grok 이 `initialize` → `tools/list` → `tools/call` 을 정상 수행했다. `initialize` 응답의
  `mcpCapabilities: {http, sse}` 에 stdio 가 없어 오해하기 쉽지만 stdio 는 기본 지원이다.

## 발견된 문제 (이번 범위 밖, 고치지 않음)

- `AcpBackend.requestPermission` 이 `toolCall.id` 를 읽는데 Grok 은 `toolCallId` 로 보낸다 →
  `randomUUID()` 로 대체되어 권한 카드 id 가 실제 도구 호출과 대응하지 않는다.
  bypassPermissions 로 도는 데스크탑 세션에서는 드러나지 않는다.
- 같은 핸들러의 승인 옵션 매칭이 `proceed_once`/이름에 "once" 포함을 찾는데 Grok 은
  `allow-once`(name "Yes, proceed")를 보낸다. 지금은 `options[0]` 폴백이 우연히 맞을 뿐이다.
- `toolCallIdToNameMap` 은 어디서도 정리되지 않는다(이번 변경 이전부터).

## 다음 세션 시작점

1. happy-cli 릴리스 → `aplus-dev-studio-desktop/config/happy-runtime-pin.json` 갱신.
2. 핀 갱신 후 실제 Grok 세션으로 확인: 도구 카드에 이름·명령어가 뜨는지, 첫 턴에서 제목이 잡히는지.
   확인 지점은 `~/.happy_remote/logs/*.log` 의 `Tool call START: … (… -> <name>)` 줄.
