# Preview relay Origin 정규화 Tasks

> plan.md의 각 Phase를 실행 단위로 분해한 체크리스트. 번호(T1, T2, ...)가 곧 실행 순서.
> 규칙: 승인 후에는 순서대로 **연속 실행** (한 번에 하나씩, 작업마다 재승인 없음).
> 각 작업 = 테스트 → 구현 → 전체 테스트 → 커밋 → 체크. Phase 경계와 중단 조건에서만 멈춤.

## 실행 순서 근거 (한 줄)

T1(HTTP 경로 실패 테스트)→T2(구현)가 먼저(Phase 1이 더 단순하고 독립적인 unit
seam이라 리스크가 낮음) → T3(WS 경로 실패 테스트)→T4(구현)는 Phase 1과 완전히 독립된
파일이지만 같은 패턴을 재사용하므로 뒤에 배치(먼저 검증된 패턴을 그대로 적용) →
T5(전체 회귀)는 둘 다 끝나야 의미가 있어 마지막 → T6(수동 검증)·T7(문서화)는 회귀
통과가 전제.

## Phase 1: HTTP 경로(`previewProxy.ts`) Origin 재작성

- [ ] T1. `previewProxy.test.ts`에 실패 테스트 2개 추가 — (a) 요청에
      `headers: { Origin: 'https://mid-30003.preview.saycode.ai' }`를 주면 upstream
      테스트 서버가 실제로 받는 `req.headers.origin`이 `http://127.0.0.1:{port}`인지
      검증(테스트 서버가 자신이 받은 origin 헤더를 응답 본문에 echo하도록 구현), (b)
      `headers: {}`(Origin 없음)일 때 upstream이 받는 요청에 `origin` 키 자체가 없는지
      검증 → 검증: 두 테스트 모두 **실패**(아직 미구현)로 시작하는 걸 확인
- [ ] T2. `previewProxy.ts`의 `stripHopByHop`(또는 `proxyHttp` 내부, 헤더 조립
      직후) 에서 `origin`/`Origin` 키를 대소문자 무시로 찾아 값이 있으면
      `http://127.0.0.1:${req.port}`로 치환하는 로직 추가 → 검증: T1의 2개 테스트
      통과, `previewProxy.test.ts` 기존 케이스 전부 통과, typecheck 통과, 커밋

## Phase 2: WS 경로(`previewWebSocketRelay.ts`) Origin 재작성

- [ ] T3. `previewWebSocketRelay.spec.ts`의 `describe('serializeUpgradeRequest')`에
      실패 테스트 2개 추가 — 기존 `Host` 재작성 테스트(line ~96)를 본떠 (a)
      `rawHeaders`에 `['Origin', 'https://mid-6080.preview.saycode.ai', ...]`를 넣고
      직렬화된 바이트를 파싱해 `Origin: http://127.0.0.1:{port}` 라인이 나오는지
      문자열 검증, (b) `Origin` 헤더가 `rawHeaders`에 없으면 직렬화된 바이트에도
      `Origin:` 라인이 생기지 않는지 검증 → 검증: 두 테스트 실패로 시작
- [ ] T4. `serializeUpgradeRequest`의 헤더 순회 루프(기존 `key.toLowerCase() ===
      'host' ? ... : rawHeaders[i+1]` 3항식)에 `origin` 케이스를 대칭으로 추가
      (`key.toLowerCase() === 'host' ? loopback : key.toLowerCase() === 'origin' ?
      'http://'+loopback : rawHeaders[i+1]`, `loopback = '127.0.0.1:'+port` 재사용) →
      검증: T3의 2개 테스트 통과, `previewWebSocketRelay.spec.ts` 전체 통과, typecheck
      통과, 커밋

## Phase 3: 전체 회귀 + 실기기 검증

- [ ] T5. `pnpm -C packages/happy-cli typecheck && pnpm -C packages/happy-cli test`,
      `pnpm -C packages/happy-server typecheck && pnpm -C packages/happy-server test`
      전체 실행 → 검증: 전부 통과(특히 `previewRoutesCredentials.spec.ts`,
      `previewRoutesStripHeaders.spec.ts`, `previewRoutesRelay.spec.ts`,
      `previewWsProxy.test.ts`, `previewWsRelay.live.test.ts`가 이 변경으로 깨지지
      않는지 — spec.md R4 회귀 확인)
- [ ] T6. (가능하면) 이 브랜치의 daemon으로 `aplus-dev-studio-app` 프리뷰를 띄우고,
      `app.config.js`의 `EXPO_PREVIEW_ORIGIN` 주입을 일시적으로 끈 상태에서도
      (`.env`의 `EXPO_PREVIEW_ORIGIN` 주석 처리) `curl -H "Origin:
      <preview-url>" <bundle-url>`이 200인지 확인 → 검증: 200 확인되면 근본 원인
      해결의 최종 증거. 로컬 daemon 교체가 여의치 않으면 이 태스크는 스킵하고
      context.md에 "미검증, T5까지만 확인"으로 명시(중단 조건 아님 — 정보 기록)

## Phase 4: 문서화

- [ ] T7. `context.md`에 완료 요약 작성. `specs/preview-relay-credential-passthrough/context.md`의
      "남은 이슈" 절 중 `Origin` 헤더 그대로 전달 항목에 `→ specs/preview-relay-origin-normalization/
      에서 해결` 각주 추가 → 검증: 문서 리뷰(코드 변경 없음)

## 승인 대기 중인 추가 작업 (스코프 확장 제안)

- [ ] (제안) happy-cli 릴리스(버전 bump·태그·`npm publish`) — 이 spec 구현이 끝난 뒤
      별도 승인 필요(`AGENTS.md` "Happy CLI Release Publisher" 정책). 릴리스 전까지는
      `aplus-dev-studio-app`의 `app.config.js` 워크어라운드가 계속 필요하다.
