# Context

- Worktree created from `origin/main` at `69f966f1f115131d201a9b89117771a98d879a1d`.
- The legacy AI backend profile feature was removed and must not be restored.
- This feature stores launch selections only: name, agent, model, and worktree-enabled state.
- happy-server owns persistence and the API; web and mobile are clients.
- Added `AgentLaunchProfile` with account/name uniqueness, account cascade deletion, and a partial unique index that permits at most one active profile per account.
- Added authenticated CRUD at `/v1/account/agent-profiles`; deletion returns the newly active profile so clients do not need a reconciliation fetch.
- Mobile can consume the same CRUD contract directly; no web-only proxy or local-storage source of truth is involved.
- Self-review added Fastify route tests for authentication, account scoping, timestamp serialization, and delete fallback responses.
- A second self-review fixed PATCH behavior so an explicit `activate: false` deactivates a profile instead of being silently ignored.
- Final review maps the account/name unique constraint to `name-conflict` and the partial active-profile constraint to `active-conflict`, avoiding misleading duplicate-name responses during concurrent activation.
- Verification: all happy-server tests 660/660, happy-server typecheck, Prisma schema validation, and `git diff --check` passed on 2026-08-13.
