# Preview relay Origin 정규화 Context

> 마지막 갱신: 2026-07-28 / 상태: **구현 완료(T1~T5, T7). T6(실기기 daemon 교체 검증)만
> 의도적으로 스킵 — 아래 참고. PR/릴리스는 아직.**
> 목적: 다음 세션의 Claude가 이 파일 하나만 읽고 즉시 이어서 작업할 수 있게 한다.

## 현재 상태 (3~5문장)

`aplus-dev-studio-app`(별도 저장소, Expo 프로젝트)에서 프리뷰 흰 화면 버그를 조사하다가,
근본 원인이 그 프로젝트가 아니라 이 vendor/happy 저장소의 preview relay에 있다는 걸 확인했다.
relay는 dev 서버로 요청을 전달할 때 `Host`는 이미 항상 `127.0.0.1:{port}`로 재작성하는데
`Origin`은 브라우저가 보낸 프리뷰 도메인 그대로 전달한다 — 이 비대칭 때문에 Host/Origin을
비교하는 모든 dev 서버 미들웨어(Expo `CorsMiddleware` 등)가 cross-origin으로 오판해 요청을
거부한다. `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈"에 이미
발견돼 있던 갭이었다. HTTP 경로(`previewProxy.ts`, T1~T2)와 WS 업그레이드 경로
(`previewWebSocketRelay.ts`, T3~T4)에 각각 대칭적인 Origin 재작성을 TDD로 구현했고,
happy-cli(typecheck+test 145/147 파일, 실패 2개는 무관한 기존 flake)와 happy-server
(typecheck+test 39/39 파일 478/478 전부 통과)로 회귀를 확인했다(T5). 브랜치
`preview-relay-origin-normalization`에 커밋 2개(14ab6b6d, 7ff62423). PR 생성 및
happy-cli 릴리스는 아직 하지 않음 — 둘 다 사용자 승인 필요.

## 다음 세션 시작점

구현은 끝났다. 다음 단계는 (a) 이 브랜치를 push하고 PR을 만들지, (b) T6(실기기 검증)를
언제·어떻게 안전하게 할지, (c) happy-cli 릴리스(버전 bump+태그+`npm publish`, `AGENTS.md`
정책상 별도 승인 필요)까지 진행할지를 사용자와 정하는 것. 셋 다 이 세션에서는 승인받지
않았다.

## 작업 환경 — 격리된 worktree 사용 (중요)

이 저장소(`vendor/happy`)의 메인 체크아웃(`/Users/justin/workspace/aplus-dev-studio/vendor/happy`)은
**여러 동시 Claude Code 세션이 공유**하고 있다(`ps aux`로 10개 이상의 활성 happy-cli daemon/세션
프로세스 확인됨). 이번 세션 중 실제로 다른 세션이 그 메인 체크아웃에서
`git checkout fix/session-idle-mode-guard`를 실행해, 내가 만든 커밋이 순간적으로 남의
브랜치에 잘못 붙는 사고가 있었다(즉시 발견해 cherry-pick으로 옮기고 원래 브랜치 포인터를
복구함 — 작업 트리 파일은 건드리지 않아 피해 없음). 그 이후로는 메인 체크아웃을 detached
상태로 남겨두고, 실제 작업은 `git worktree add /tmp/happy-preview-origin-normalization
preview-relay-origin-normalization`로 만든 격리된 worktree에서 했다. **다음 세션도 메인
체크아웃에서 직접 커밋하지 말고, 이 worktree(있으면 재사용, 없으면 새로 생성)에서 작업할
것.** worktree는 `pnpm install`이 별도로 필요(로컬 pnpm store 캐시 덕에 약 20초).

## 결정 로그

- **재작성 지점을 `previewRoutes.ts`(happy-server, 브라우저↔relay 경계)가 아니라
  `previewProxy.ts`/`previewWebSocketRelay.ts`(relay↔dev서버 경계, 즉 이미 `Host`를
  재작성하는 바로 그 지점)로 잡았다.** 이유: `previewRoutes.ts`는
  `request.headers.origin`을 응답 CORS 헤더(`applySubdomainPreviewCorsHeaders`)에도
  쓰고 있어서, 거기서 재작성하면 "브라우저가 보낸 원본 Origin"과 "upstream에 보낼
  재작성된 Origin" 두 값을 구분해서 daemon에 넘겨야 해 프로토콜(payload 스키마)이
  늘어난다. `previewProxy.ts`는 `port`만 있으면 `Origin`을 계산할 수 있는 지점이라
  기존 시그니처를 안 건드리고 끝난다. → 재검토 조건: 만약 나중에 relay가 `kind`
  (frontend/backend)별로 다르게 처리해야 하는 요구가 생기면, 그때는 daemon↔server
  프로토콜에 `kind`를 얹는 별도 spec이 필요하고 이 결정도 같이 재검토.
- **재작성을 `kind` 무관하게 전부 적용하기로 했다(비목표에 명시).** `Host`가 이미
  오늘도 무조건 재작성되고 있어서, `Origin`만 예외적으로 유지하는 게 오히려 더
  일관성이 없다고 판단. 이론적으로 어떤 프로젝트의 백엔드가 이 relay 뒤에서 Origin
  기반 CSRF 방어를 하고 있었다면 이 변경으로 그 방어의 "실제 브라우저 Origin을
  본다"는 전제가 깨질 수 있음 — 발견되면 재검토(spec.md 비목표 참고).
- **T6(실기기 daemon 교체 검증)를 스킵했다.** 실행 중인 daemon이 여러 동시 세션을
  서빙하고 있어(바로 위 "작업 환경" 절 참고), 라이브 교체는 무관한 다른 세션의 프리뷰를
  끊을 위험이 있는 공유 인프라 변경이라 판단 — 사용자 승인 없이 하지 않음. 대신
  단위 테스트(T1~T4)가 정확히 실제 버그의 재현 조건(`aplus-dev-studio-app`에서 실측한
  `curl -H "Origin: <preview-url>" <bundle-url>` 200/500 분기)을 assert하도록 작성해
  간접 검증으로 대체했다.

## 결정 로그

- **재작성 지점을 `previewRoutes.ts`(happy-server, 브라우저↔relay 경계)가 아니라
  `previewProxy.ts`/`previewWebSocketRelay.ts`(relay↔dev서버 경계, 즉 이미 `Host`를
  재작성하는 바로 그 지점)로 잡았다.** 이유: `previewRoutes.ts`는
  `request.headers.origin`을 응답 CORS 헤더(`applySubdomainPreviewCorsHeaders`)에도
  쓰고 있어서, 거기서 재작성하면 "브라우저가 보낸 원본 Origin"과 "upstream에 보낼
  재작성된 Origin" 두 값을 구분해서 daemon에 넘겨야 해 프로토콜(payload 스키마)이
  늘어난다. `previewProxy.ts`는 `port`만 있으면 `Origin`을 계산할 수 있는 지점이라
  기존 시그니처를 안 건드리고 끝난다. → 재검토 조건: 만약 나중에 relay가 `kind`
  (frontend/backend)별로 다르게 처리해야 하는 요구가 생기면, 그때는 daemon↔server
  프로토콜에 `kind`를 얹는 별도 spec이 필요하고 이 결정도 같이 재검토.
- **재작성을 `kind` 무관하게 전부 적용하기로 했다(비목표에 명시).** `Host`가 이미
  오늘도 무조건 재작성되고 있어서, `Origin`만 예외적으로 유지하는 게 오히려 더
  일관성이 없다고 판단. 이론적으로 어떤 프로젝트의 백엔드가 이 relay 뒤에서 Origin
  기반 CSRF 방어를 하고 있었다면 이 변경으로 그 방어의 "실제 브라우저 Origin을
  본다"는 전제가 깨질 수 있음 — 발견되면 재검토(spec.md 비목표 참고).

## 시도했으나 기각한 접근

- happy-server의 `previewRoutes.ts` 응답 CORS 로직 쪽에서 재작성 — 위 결정 로그 참고,
  daemon 프로토콜 확장이 필요해 기각.
- Origin 헤더를 아예 제거(delete) — 기각. "Origin 없음"과 "same-origin"을 다르게
  다루는 미들웨어가 있을 수 있어, loopback 값으로 채우는 쪽이 의미상 더 정확
  (dev 서버 입장에서 실제로 자기 자신에게 오는 요청이 맞음).

## 발견된 문제 (이번 범위 밖)

- `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈" 중
  third-party cookie phase-out(CHIPS/Partitioned 필요성)은 이 spec과 무관, 별도.
- `aplus-dev-studio-app`의 `app.config.js`+`.env`(`EXPO_PREVIEW_ORIGIN`) 워크어라운드는
  이 spec이 릴리스되어 실제로 그 프로젝트에 반영되기 전까지 계속 필요 — 되돌리는 건
  별도 승인 필요한 다른 저장소 작업이라 이번 스코프에 포함 안 함.

## 바뀐 파일

| 파일 | 내용 |
|---|---|
| `packages/happy-cli/src/daemon/previewProxy.ts` | `stripHopByHop`이 `Origin`을 `http://127.0.0.1:{port}`로 재작성(loopback 인자 추가) |
| `packages/happy-cli/src/daemon/previewProxy.test.ts` | Origin 재작성 케이스 2개(있음/없음) |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.ts` | `serializeUpgradeRequest`가 `Host`와 대칭으로 `Origin` 재작성 |
| `packages/happy-server/sources/modules/preview/previewWebSocketRelay.spec.ts` | Origin 재작성 케이스 2개(있음/없음) |
| `specs/preview-relay-credential-passthrough/context.md` | "남은 이슈"의 Origin 항목에 이 spec으로의 각주 링크 |

검증: happy-server 전체 스위트 39파일/478개 통과, happy-cli typecheck 통과 +
145/147 파일(무관한 기존 flake 2케이스 제외) 통과. 커밋: 14ab6b6d(T1-T2),
7ff62423(T3-T4).
