# Plan — Session Skill Governance PR Conflict

## Phase 1 — Conflict reconciliation (done)

- Merge `origin/main` into `feat/session-skill-governance`, preserving both the
  PR's skill-governance SDK options and main's expected MCP-service guidance.
- Verify `claudeRemote.ts` computes connector guidance from the merged MCP
  server set before composing the system prompt.

## Phase 2 — Regression coverage (done)

- Add the smallest `claudeRemote` regression test proving skill governance and
  expected MCP service guidance are both present in one remote session.
- Run the new test first to demonstrate the pre-resolution failure where
  practical, then implement only the conflict-resolution changes needed.

## Phase 3 — Focused verification (done)

- Run the affected Happy CLI unit tests and TypeScript typecheck.
- Review the final merge diff for preservation of both parent branches' behavior.

## Success criteria

- PR #171 is mergeable with `main`.
- `HAPPY_SETTING_SOURCES` / `HAPPY_SKILL_ALLOWLIST` still reach the SDK query
  options, and connector/MCP-service discovery instructions from `main` remain
  in the appended system prompt.
