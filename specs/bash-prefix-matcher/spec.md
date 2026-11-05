# bash-prefix-matcher

aplus-dev-studio-desktop `specs/desktop-permission-prefix-grant` (승인 2026-10-24, R3·R6·R7)의 happy-cli 쪽 선행 작업(Phase 1). Desktop 카드·메뉴(Phase 2)는 이 변경이 발행·pin된 뒤 별도 PR이다.

## 배경

Desktop이 permission RPC 응답에 `decision: 'approved_for_session'`과 `allowTools: ['Bash(<접두>:*)']`를 실으면 Claude `permissionHandler`가 `parseBashPermission`으로 `allowedBashPrefixes`에 넣고, 뒤의 Bash 호출을 `command.startsWith(prefix)`로 판정했다.
경계도 복합 명령 분해도 없어서 `Bash(git add:*)`가 `git addx`, `git add . && rm -rf ~`, `git add \"; rm -rf ~; echo \"`를 모두 통과시켰다. 이 매처 위에서는 접두 grant가 "이 대화에서 모든 Bash 허용"과 같다.

## 요구사항

1. **평문 명령 판정** `isPlainBashCommand` (Desktop R3와 같은 규칙, `src/claude/utils/bashPrefixMatcher.ts`)
   - 한 줄, 4000자 이하, 공백만이 아님. 제어 문자(개행·`\r`·탭·NUL)·유니코드 줄 구분자 없음.
   - 역슬래시·`$`·백틱은 따옴표 안팎 어디에도 없음.
   - 따옴표 밖에 `& | ; < > ( )` 없음, 토큰 시작 `#` 없음, 따옴표 짝이 맞음.
   - 첫 단어(따옴표 제거 후)가 환경 할당(`FOO=bar`)이나 래퍼(`command builtin exec eval source . time timeout nice nohup xargs env sudo doas`, basename·대소문자 무시)가 아님. 래퍼 벗기기는 하지 않는다.
2. **접두 매칭** `bashPrefixAllows(prefix, command)` (Desktop R7 ii)
   - prefix와 command가 모두 평문이어야 하고, prefix는 앞뒤 공백이 없어야 한다(빈 접두가 공백으로 시작하는 명령을 전부 허용하는 경로 차단).
   - `command === prefix || command.startsWith(prefix + ' ')`.
3. **리터럴 `Bash(<명령>)`은 정확 일치 그대로**(Desktop R7 iii). 변경 없음.
4. **표지**: machine metadata `permissionGrants: { bashPrefixMatcher: 'plain-v1' }`. 데몬 최초 등록과, 이미 등록된 머신의 갱신(`apiMachine` stale 판정) 양쪽에서 싣는다. 표지가 없으면 Desktop은 접두 선택지를 보이지 않는다(fail-closed).
5. **공유 사례 파일** `src/claude/utils/bashPrefixMatcher.cases.v1.json` — Desktop `specs/desktop-permission-prefix-grant/cases.v1.json`과 같은 파일. `plainCommand`·`matcher`·`compoundInjection` 섹션을 이 저장소 테스트가 전부 읽는다. Desktop 쪽은 후보·금지 섹션(R4·R5)을 Phase 2에서 더한다.

## 결정

- **적용 범위는 allow 접두 매칭뿐이다.** deny 규칙(`generateHookSettings.ts`의 `Bash(killall:*)`, `machineLockdownPolicy.ts`의 `Bash(env:*)` 등)은 Claude CLI의 `--disallowedTools`·settings로 전달돼 CLI가 평가한다. 이 핸들러의 `allowedBashPrefixes`를 거치지 않으므로 deny의 "넓게 막기" 의미는 바뀌지 않는다. `allowedBashPrefixes`에는 응답의 `allowTools`만 들어간다.
- 모바일 앱이 보내는 `allowedTools`의 `Bash(x:*)`에도 같은 매처가 적용된다. 허용 범위가 줄어들 뿐(복합 명령·경계 밖은 다시 묻는다)이다.
- 금지 접두사 목록(Desktop R5)은 이 저장소에 두지 않는다. 데몬은 어떤 접두를 받든 평문·경계 규칙만 집행하고, "어떤 접두를 제안할지"는 Desktop이 정한다.

## 비목표

- 래퍼 벗기기, 쉘 파서, 이스케이프 지원, 와일드카드(`git *`), 영구 허용.
- Codex·Gemini·ACP 처리기(`BasePermissionHandler`)는 `allowTools`를 읽지 않는다 — 대상 아님.
