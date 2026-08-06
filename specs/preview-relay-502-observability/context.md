# Context

## 2026-08-06 — Phase 1, 2 완료

브랜치 `fix/preview-relay-502-observability`.

### 무엇을 했나

- **Phase 1 [구조적]** `previewRoutes.ts` 의 `upstreamPath` 계산을 머신 소켓
  조회 위로 이동. 동작 변경 없음, 프리뷰 스펙 4종(51 tests) 이동 전후 통과.
- **Phase 2 [동작]** `describePreviewRelayFailure()` 를 export 하고 두 실패
  분기에서 `log({ module: 'preview', level: 'warn' }, …)` 호출.
  기존 인라인 상태 매핑(400/504/502)을 그 함수 안으로 옮겨 처음으로
  테스트를 붙였다.

### 상태

- `previewRoutesFailureLog.spec.ts` 6 tests
- `pnpm vitest run` 전량 통과: 43 files / 499 tests
- `tsc --noEmit` 클린

### 배포 후 보이게 될 로그

```
WARN  preview relay failed reason=daemon:CONNECTION_REFUSED status=502 \
      method=HEAD machine=c93c0067-… port=30023 user=cmpawdinb… \
      path=/ candidates=1 detail=connect ECONNREFUSED 127.0.0.1:30023
ERROR HEAD /v1/preview/:machineId/:port/* 502 12ms
```

액세스 로그는 손대지 않았으므로 여전히 ERROR 로 찍힌다 — 그 레벨 조정은
spec Non-Goals 의 별도 트랙이다.

### 판단 근거로 남길 것

- `machine-offline` / `daemon:*` 둘 다 **warn** 이다. 전자는 노트북을 닫은
  정상 상황, 후자의 `CONNECTION_REFUSED` 는 dev 서버 기동 중 정상. error 로
  올리면 알람이 전부 오탐이 된다.
- 상태 코드는 **의도적으로 그대로** 두었다. web-ui `checkPortReachable()` 이
  502/504 를 "아직 안 뜸"으로 폴링하는 계약이 있어 여기서 바꾸면 배포된
  프런트가 오판한다. 분리는 web-ui 선배포가 전제.

### 다음에 볼 것 (이번 범위 밖)

- `CONNECTION_REFUSED` → 503 분리 (web-ui 선배포 필요)
- 프리뷰 릴레이 라우트의 액세스 로그 5xx 레벨 하향
- `previewWebSocketRelay.ts:282,316` 의 WS 502 에 같은 처리
- 같은 pod 로그에서 관측된 무관한 2건: `Can't reach database server …:5432`
  8시간에 9회(session-cache flush, 매번 ~60ms 뒤 재시도 성공),
  `MaxListenersExceededWarning: 11 abort listeners on AbortSignal` 1회
