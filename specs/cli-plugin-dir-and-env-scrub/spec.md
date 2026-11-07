# cli-plugin-dir-and-env-scrub — remote Claude `--plugin-dir` 전달과 자식 env 스크럽 키 점검

정본: Desktop `specs/happy-upstream-benchmark/spec.md` R5 (작업 H4, 2026-11-07 사용자 승인).
upstream 참고: slopus/happy d75b9df23 `fix(cli): forward plugin directories in remote Claude sessions`(`claude/utils/pluginsFromArgs.ts`), `daemon/sessionEnvironment.ts`의 `SESSION_SCOPED_ENV_KEYS`. 파일은 그대로 복사하지 않고 포크 구조에 맞게 씁니다.

## 문제

1. `happy claude -- --plugin-dir <dir>`로 플러그인 디렉터리를 주면 터미널(local) 실행은 Claude가 인자를 직접 받지만, remote(SDK) 실행은 그 인자를 SDK `plugins` 옵션으로 옮기지 않아 플러그인이 빠진다. 포크의 `claudeRemote.ts`는 Claude가 보고한 `systemInit.plugins`만 메타데이터로 올린다.
2. upstream은 `HAPPY_FORK_CODEX_THREAD_ID`·`HAPPY_SIDE_CHAT`·`CODEX_THREAD_ID`를 세션 범위 env로 지운다. 포크 `utils/childEnv.ts`의 `NON_INHERITABLE_ENV`(prefix 기반)에 이 셋이 있는지 확인이 필요하다.

## 요구사항

- **R5** (정본 그대로) Given `happy claude -- --plugin-dir <dir>` 인자, When remote start·resume, Then SDK `plugins` 옵션에 그 디렉터리가 전달된다. `utils/childEnv.ts` 스크럽 목록에 `CODEX_THREAD_ID`·`HAPPY_SIDE_CHAT`이 없으면 추가한다(prefix 구조 유지).

### 세부

- **R5-a** `claude/utils/pluginsFromArgs.ts`(upstream 계약과 같게)
  - `--plugin-dir <p>`와 `--plugin-dir=<p>` 두 형식을 읽고, 여러 번 주면 순서대로 모두 넣는다.
  - `--`를 만나면 거기서 멈춘다(그 뒤는 Claude 인자가 아니다).
  - 값이 없거나(`--plugin-dir`가 마지막), 다음 인자가 `-`로 시작하거나, 빈 문자열이거나, NUL을 품으면 `--plugin-dir requires …` 오류를 던진다.
  - 상대경로는 세션 경로(`opts.path`) 기준으로 절대화한다. 데몬이 띄운 runner의 프로세스 cwd는 세션 경로와 다를 수 있다. 체크포인트 턴의 `providerPath`가 아니라 세션 경로를 쓰는 이유: 사람이 인자를 준 기준이 세션 경로이고, 터미널 실행도 Claude를 그 경로에서 띄운다.
  - 결과는 `{ type: 'local', path }[]`, 하나도 없으면 `undefined`(SDK 기본 동작 유지). 입력 배열은 바꾸지 않는다.
  - remote start(`sessionId` 없음)와 resume(`sessionId` 있음, 또는 인자의 `--resume <id>`) 모두 같은 query 옵션 조립을 지나므로 양쪽에서 `plugins`가 실린다. 테스트는 둘을 따로 단언한다.
  - 잘못된 인자는 SDK를 부르기 전에 그 실행을 실패시킨다. 원격 launcher는 이를 launch 실패로 그 턴에 알리고 다음 메시지를 기다린다(기존 launch 오류 경로, 무한 재시작 없음).
  - `sdk/types.ts`의 `QueryOptions`에 `plugins?: Options['plugins']`, `sdk/query.ts`가 그대로 SDK에 넘긴다.
  - **사용자 지정 목록과 Claude 보고 목록의 관계**: `plugins` 옵션은 Claude에 주는 **입력**이고, `systemInit.plugins`는 Claude가 실제로 불러온 플러그인의 **보고**다(사용자 지정 + 설치된 플러그인). 둘을 합치지 않는다. 메타데이터의 `plugins`는 지금처럼 Claude 보고만 쓴다 — 불러오기에 실패한 경로를 "불러옴"으로 보이지 않기 위해서다.
  - 필수 샌드박스(`processSandbox`)에서도 그대로 넘긴다. 터미널 실행도 같은 인자를 막지 않고, 플러그인은 샌드박스에 갇힌 Claude 프로세스가 읽으므로 그 파일시스템 경계를 그대로 받는다.
- **R5-b** `utils/childEnv.ts`의 prefix 구조와 세 분류를 유지한다.
  - `HAPPY_FORK_CODEX_THREAD_ID`: **이미 포함** — `HAPPY_FORK` prefix(session-lineage). 테스트로 고정.
  - `HAPPY_SIDE_CHAT`: 없었음 → `spawn-seed`로 추가. upstream에서 데몬이 곁대화 spawn 한 번에만 `'1'`로 넣고 runner가 읽는 일회성 입력이다(`HAPPY_INITIAL_`과 같은 성격). 포크는 아직 쓰지 않지만, 데몬이 상속한 값이 이후 모든 세션을 곁대화로 오인시키는 경로를 미리 막는다.
  - `CODEX_THREAD_ID`: 없었음 → `session-lineage`로 추가. Codex가 **자기** 도구 셸에 넣는 thread 식별자다. happy 프로세스(데몬·runner·`happy` 명령)에서 이 값이 보이면 언제나 그 프로세스를 띄운 다른 Codex 세션의 것이므로, 세션 경계뿐 아니라 세션 안 자식(에이전트 CLI·셸)에도 넘기지 않는다. Codex는 자기 셸에 자기 값을 새로 넣는다.
- **R5-c** 포크에서 세 키를 설정·읽는 곳(`git grep`): `HAPPY_FORK_CODEX_THREAD_ID`만 있다 — 데몬 `daemon/run.ts`가 fork spawn의 `extraEnv`로 명시해 넣고 `codex/runCodex.ts`가 읽는다. 명시 값은 스크럽 뒤에 쓰므로 영향이 없다(기존 계약, 테스트로 고정). `HAPPY_SIDE_CHAT`·`CODEX_THREAD_ID`는 포크 소스에서 설정·읽는 곳이 없어, 자식이 꼭 상속해야 하는 경로가 없다.
- 회귀 금지: `childEnv.ts`를 upstream의 키 목록 방식으로 되돌리지 않는다. 기존 항목·분류는 그대로다.

## 범위 밖

- 터미널(local) 실행의 `--plugin-dir` 처리(이미 Claude가 직접 받는다).
- 메타데이터에 "사용자 지정이지만 불러오지 못한 플러그인"을 따로 표시하는 일.
