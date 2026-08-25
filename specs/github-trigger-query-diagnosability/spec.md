# GitHub 트리거 조회의 비용과 진단 가능성

## 배경

2026-08-25~26 운영 사고. GitHub 트리거가 실패하는데 UI 에는 `최근 발화: 조회 또는
실행 실패` 한 줄만 남아 원인을 좁히는 데 하루가 걸렸다. 실패는 세 계층에서
연달아 드러났고, 매번 **사유를 아는 코드가 그것을 버리고 있었다.**

| 계층 | 증상 | 해결 |
|---|---|---|
| credential exchange | `403` 만 로깅 (서버는 5가지 이유로 403) | `1.1.10-aplus.136` (#258) |
| gh 실행 | `GitHub query failed` 고정 문자열 | `1.1.10-aplus.137` (#260) |
| gh 조회 결과 | 권한 없으면 오류가 아니라 **0건** | 이 스펙 |

`.137` 로 드러난 마지막 실패는 `HTTP 504` — GitHub GraphQL 게이트웨이 타임아웃이다.

## 문제

### P1. 쓰지 않는 데이터를 요청해 조회가 타임아웃한다

`GH_PR_LIST_COMMAND` 는 항상 `changedFiles,files` 를 요청한다. `files` 는 PR 100개
각각의 변경 파일 목록을 GraphQL 로 가져오는, 이 쿼리에서 가장 비싼 필드다.

그런데 이 값은 `matchesFilter` 에서 **`filter.paths` 가 비어 있지 않을 때만** 쓰인다:

```ts
if (filter.paths.length > 0) {
  if (pr.changedFiles > pr.files.length) return false;
  if (!pr.files.some(...)) return false;
}
```

`paths` 가 빈 트리거는 이 데이터를 한 번도 참조하지 않는다. 그런데도 매 폴링마다
가져오다가, PR 이 크고 많은 저장소(`buzzni/aplus-dev-studio`)에서 GitHub 이 504 를
낸다. 같은 명령이 `buzzni/hsmoa_backend` 에서는 3.9초로 통과해 저장소마다 결과가
갈렸다.

### P2. 권한이 없으면 실패가 아니라 침묵이다

실행 계정 PAT 에 `Issues` 권한이 없으면 `gh issue list` 는 오류가 아니라 **빈 배열**
을 돌려준다(GitHub 은 권한 없는 리소스를 "없는 것" 으로 취급한다). 명령은 exit 0
이므로 어떤 오류 로깅으로도 잡히지 않는다.

실제로 이 사고에서 열려 있는 이슈가 있는데도 `highestIssueNumber: 0` 이 기록됐고,
로그에는 아무 줄도 남지 않았다. 첫 관측은 baseline 만 기록하고 발화하지 않으므로
(fail-closed, 의도된 동작) 사용자에게는 "눌러도 아무 일도 안 일어남" 으로 보인다.

### P3. 로그 접두사가 중복된다

`serverAutomationExecutor` 가 `GitHub query failed: ${query.error}` 로 로깅하는데
`.137` 이후 `query.error` 자체가 `GitHub query failed: ...` 로 시작한다.

```
cmt8lc60i GitHub query failed: GitHub query failed: Command failed: gh pr list ...
```

### P4. 절단이 정작 필요한 부분을 자른다

`describeQueryFailure` 는 200자로 자르는데, Node 의 exec 오류 메시지는
`Command failed: <명령 전문>\n<stderr>` 형태다. `gh pr list ...` 명령이 180자라
예산을 거의 다 먹고 stderr 가 `HTTP 504: We cou…` 에서 잘렸다. 상태 코드는 겨우
살아남았다.

## Acceptance Criteria

### AC1 — paths 필터가 없으면 파일 목록을 요청하지 않는다
- Given `filter.paths` 가 빈 GitHub 트리거
- When 데몬이 PR 을 조회하면
- Then `gh pr list` 명령에 `changedFiles` 와 `files` 가 포함되지 않는다

### AC2 — paths 필터가 있으면 지금과 동일하게 요청한다
- Given `filter.paths` 가 하나 이상인 트리거
- When 데몬이 PR 을 조회하면
- Then 명령에 `changedFiles,files` 가 포함되고 경로 필터링이 그대로 동작한다

### AC3 — 파일 목록이 없어도 조회 결과 파싱이 성공한다
- Given `changedFiles`/`files` 없이 돌아온 `gh` 출력
- When 스키마가 파싱하면
- Then 실패하지 않고 각각 `0` 과 `[]` 로 채워진다

### AC4 — 첫 baseline 을 관측 수와 함께 남긴다
- Given 런타임 상태가 없는 GitHub 트리거
- When 첫 조회가 성공해 baseline 을 기록하면
- Then 관측 건수를 담은 로그 한 줄이 남는다
- And 관측이 0건이면 실행 계정 권한 가능성을 함께 안내한다

### AC5 — 로그 접두사가 중복되지 않는다
- Given 조회 실패로 `query.error` 가 자기 서술적 메시지일 때
- When executor 가 로깅하면
- Then `GitHub query failed:` 가 한 번만 나타난다

### AC6 — 실패 사유에서 명령 에코를 걷어낸다
- Given `Command failed: <명령>\n<stderr>` 형태의 오류
- When 사유를 만들면
- Then 명령 에코를 제거하고 stderr 를 남긴다
- And 200자 예산이 stderr 에 쓰인다

## 범위 밖

- GitHub 504 자체의 재시도/백오프 — P1 로 쿼리 비용이 줄면 필요 여부를 다시 판단한다
- `--limit 100` 조정 — 발화 누락 위험이 있어 별도 판단 대상이다
- 권한 부족을 능동 probe 로 확정하는 것 — GitHub 이 권한 없는 조회를 어떻게
  응답하는지 실측 없이 가정하지 않는다. AC4 는 사실(관측 0건)만 남기고 판단은
  운영자에게 맡긴다.
