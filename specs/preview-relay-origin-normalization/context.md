# Preview relay Origin 정규화 Context

> 마지막 갱신: 2026-07-28 / 상태: **초안 — 아직 구현 시작 전, spec/plan/tasks만 작성됨.**
> 목적: 다음 세션의 Claude가 이 파일 하나만 읽고 즉시 이어서 작업할 수 있게 한다.

## 현재 상태 (3~5문장)

`aplus-dev-studio-app`(별도 저장소, Expo 프로젝트)에서 프리뷰 흰 화면 버그를 조사하다가,
근본 원인이 그 프로젝트가 아니라 이 vendor/happy 저장소의 preview relay에 있다는 걸 확인했다.
relay는 dev 서버로 요청을 전달할 때 `Host`는 이미 항상 `127.0.0.1:{port}`로 재작성하는데
`Origin`은 브라우저가 보낸 프리뷰 도메인 그대로 전달한다 — 이 비대칭 때문에 Host/Origin을
비교하는 모든 dev 서버 미들웨어(Expo `CorsMiddleware` 등)가 cross-origin으로 오판해 요청을
거부한다. `specs/preview-relay-credential-passthrough/context.md`의 "남은 이슈"에 이미
발견돼 있던 갭이었다. 이번 세션에서 spec.md/plan.md/tasks.md만 작성했고 **구현은 아직 시작
안 함** — 다음 세션은 `tasks.md`의 T1부터 시작.

## 다음 세션 시작점

`tasks.md` T1 — `packages/happy-cli/src/daemon/previewProxy.test.ts`에 실패 테스트 2개
추가하는 것부터. Red 확인 후 T2(구현)로 진행.

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

(아직 없음 — T1부터 시작)
