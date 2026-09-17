# Plan — server

1. Contract and baseline: inspect applicable instructions and current tests, record file placement before editing.
2. Red/Green implementation: regressions first, minimal behavior fix, related tests.
3. Broader verification: appropriate typecheck/build/tests; distinguish existing failures.
4. Primary Codex review: inspect actual diff, test race/compatibility risks, apply fixes then rerun affected checks.

## Parallel work and dependencies
- Server (Claude Opus 5): authoritative event scope and no-op filtering, high difficulty.
- Desktop (Claude Opus 5): coalescing, lifecycle and cache races, high difficulty. Runs in parallel with server using backward-compatible existing events.
- Monitoring (Claude Sonnet 5): verified route metrics and rule tests, moderate difficulty. Runs in parallel for discovery; any new metric contract must be settled with server before dependent rules.
- Sequential: all implementations -> primary-agent cross-repo review -> corrections -> final verification and handoff.
Each agent writes only its assigned worktree. No two writing children share a worktree. No child spawns more agents.

## Compatibility / rollback
Existing event schema remains compatible. Legacy null events remain bounded on Desktop. Revert the scoped commits to roll back; no database migration. Deployment is separate: server first helps existing clients, Desktop next, matching monitoring contract with server.

## 최종 상태 (2026-09-17)

계약 조사, 구현, 영향 검증, 현재 Codex 리뷰와 수정 검증 완료. 운영 배포는 수행하지 않았다. 검증 수치와 기존 실패는 context.md 참조.
