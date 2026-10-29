# Codex 서브 에이전트 녹음 fixture

실제 Codex app-server 0.157.1을 stdio로 띄워 녹음한 JSON-RPC 트래픽이다(2026-10-27). 부모 스레드가 서브 에이전트(자식 스레드)를 띄울 때 Codex가 보내는 알림을 그대로 담고 있다. 사용처: `../../codexSubagentReplay.test.ts`, 재생 유틸 `../../testing/replayCodexRecording.ts`.

## 파일

| 파일 | 모델 → 멀티 에이전트 | 장면 | 보여주는 것 |
|---|---|---|---|
| `a-default-terra-v2.jsonl` | gpt-5.6-terra(기본) → V2 | 부모가 자식 1개(Linnaeus)를 띄우고 기다린 뒤 `DONE` | 자식의 첫 알림은 spawn 항목보다 먼저 오는 `thread/status/changed idle`. 부모 쪽 `subAgentActivity started/completed`, `collabAgentToolCall wait`. 자식 `turn/*`·`agentMessage`("OK")·델타 |
| `a-luna-v1.jsonl` | gpt-5.6-luna(`multi_agent_version: v1`) → V1 | (a)와 같음, 자식 Plato | `collabAgentToolCall spawnAgent` item/started(receiver 없음) → item/completed(`receiverThreadIds`, `agentsStates` `pendingInit`) → `wait` → `agentsStates` `completed` |
| `b-default-terra-v2.jsonl` | 기본 → V2 | 느린 자식(Hume)을 띄우고 기다리지 않고 `SPAWNED`로 턴 종료 | 부모 `turn/completed`(10.1초) 뒤에도 자식 알림(숫자 1~10)이 이어지고, 이미 끝난 부모 턴 id로 `subAgentActivity completed`가 온다 |
| `b-luna-v1.jsonl` | luna → V1 | (b)와 같음, 자식 Mencius | V1에는 부모 쪽 완료 항목이 없다(자식 `turn/completed`·`idle`만) |
| `c-default-terra-v2.jsonl` | 기본 → V2 | 부모 턴 중단 첫 시도, 자식 Epicurus | 중단이 자식 완료 뒤에 걸려 의도한 장면은 아니다. 부모 `turn/completed` `interrupted` |
| `c-default-terra-v2-retry.jsonl` | 기본 → V2 | 자식(Bohr)이 도는 중에 부모 `turn/interrupt` | 부모가 7.0초에 중단돼도 자식은 13.9초까지 돌고 끝난다. 그 뒤 중단된 부모 턴 id로 `subAgentActivity completed` |

공통 관찰:
- 자식 알림은 같은 stdio 연결로 온다(`turn/*`, `item/*`, 델타, `thread/tokenUsage/updated`, 자식 threadId의 `mcpServer/startupStatus/updated`, `thread/status/changed`).
- `rawResponse/completed`는 한 번도 오지 않았다.
- 메인 턴이 끝날 때 `thread/status/changed idle`이 `turn/completed`보다 먼저 온다.
- `thread/loaded/list`에는 끝난 자식도 남는다.

## 줄 형식

한 줄에 `{ "t", "ts", "dir", "msg" }` 하나. `t`는 Codex를 띄운 뒤 지난 ms, `dir`은 `out`(클라이언트 → Codex) 또는 `in`(Codex → 클라이언트), `msg`는 JSON-RPC 메시지 원문이다. 녹음 클라이언트는 모르는 스레드 id를 처음 볼 때마다 `thread/read`를 보냈고, 끝에 `thread/loaded/list`와 스레드별 `thread/read`를 한 번씩 더 보냈다. 재생할 때는 이 응답들을 녹음된 순서대로 돌려준다.

실행할 때: 반복 실행은 globalSetup 빌드(dist를 지우고 다시 만든다)를 뺀 임시 설정으로 하고, 공식 명령 `vitest run --project unit`은 마지막에 한 번만, 다른 실행과 겹치지 않게 돌린다(dist 경합). 자식 `thread/read`의 2번째 응답부터는 녹음 끝의 `idle`이므로, 폴링이 목록을 "유지"하는 경우는 녹음 재생이 아니라 합성 알림으로 테스트한다.

## 생성 방법

1. 빈 임시 cwd에서 `codex app-server --listen stdio:// -c mcp_servers={} -c features.hooks=false -c features.plugins=false -c features.memories=false`를 띄운다.
2. `initialize`(`capabilities.experimentalApi: true`) → `thread/start { ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never' }` → 장면 프롬프트로 `turn/start`를 한 번 보낸다. (c)는 자식이 도는 중에 `turn/interrupt`를 보낸다.
3. 승인 요청은 모두 거절하게 했지만 한 번도 오지 않았다.
4. 녹음 드라이버는 커밋하지 않았다. 드라이버가 기록할 때 홈 경로·이메일·토큰 모양의 값을 치환했다(홈은 `/Users/REDACTED`). 저장소에 넣을 때 녹음 메모 줄과 `account/updated`·`account/rateLimits/updated`·`remoteControl/status/changed`(호스트명·`installationId`가 들어 있음)·`configWarning` 알림 줄을 통째로 지웠다. 남은 줄과 `t`는 원본과 바이트 단위로 같다.

## 다시 녹음할 때

- 넣기 전에 지운다: 홈 경로(`/Users/REDACTED`로 치환), 이메일, 토큰, 호스트명, `installationId`, `account/*`·`remoteControl/*`·`configWarning` 알림, stderr와 메모 줄.
- 확인: `grep -il "<사용자 이름>\|<호스트 이름>\|installationId\|sk-\|eyJ" *.jsonl` 결과가 비어 있어야 한다.
- 줄 순서와 `t`는 고치지 않는다. 재생이 녹음 간격을 그대로 쓴다.
- 기존 파일의 내용을 손으로 고치지 않는다. Codex의 알림 모양이 바뀌면 새 파일을 추가한다.
- 새 파일을 넣으면 테스트의 `FIXTURES` 표(자식 threadId, 라벨, 메인 미리보기 텍스트, 자식이 메인 턴보다 오래 도는지)와 `golden/<이름>.no-subagent.json`도 함께 추가한다.

## golden/

`golden/<이름>.no-subagent.json`은 서브 에이전트 흔적을 뺀 스트림(`noSubagent`: 메인 스레드와 threadId 없는 알림만 남기고 부모 쪽 `collabAgentToolCall`·`subAgentActivity` 항목을 뺀 것, 곧 보통 세션)을 서브 에이전트 작업 전 런타임(1.1.10-aplus.360)에 통과시킨 출력이다.

- `resolvedAt`: `sendTurnAndWait`가 풀린 시점까지 나온 이벤트 수
- `eventTypes`, `envelopeSummary`: 사람이 읽기 위한 요약(테스트가 같은 규칙으로 다시 만들어 비교한다)
- `streamDeltaText`: `agent_message_delta`를 이은 미리보기 텍스트
- `events`: 클라이언트 이벤트 원문
- `envelopes`: 매퍼 envelope에서 `id`·`time`을 뺀 것. `atEvent`는 그 envelope를 만든 이벤트의 위치, `turn`은 매퍼가 무작위로 만드는 turn id를 처음 나온 순서의 번호(1, 2, …)로 바꾼 값

출처: 녹음 원본을 같은 런타임에 실시간 타이머(간격 1/4)로 재생한 결과에서 위 필드만 옮겼다. 한 군데만 다르다. `a-default-terra-v2`의 마지막 `background_tasks { tasks: [] }` 1건을 뺐다. 스레드 시작 5초 뒤 도는 첫 백그라운드 새로고침이 그 실행에서만 관찰 끝(약 4.9초) 직후 실시간 지연으로 끼어든 것이고, 가짜 타이머 재생(관찰 창 = 마지막 줄 + 2초)에는 나오지 않는다.

identity 테스트는 재생 결과를 이 파일과 통째로 비교한다(`toEqual`). 서브 에이전트 작업 뒤에도 같아야 한다. 달라지면 그 차이가 의도한 것인지 먼저 확인하고, 의도한 경우에만 golden을 고친다.
