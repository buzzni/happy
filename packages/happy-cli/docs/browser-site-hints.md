# Agent browser site notes

A skill can hold know-how for specific sites — direct URLs, keyboard shortcuts, login redirects, what not to click. When the agent browser (`browser_task_open_page`, or a `navigate` step / observed URL in `browser_task_submit_batch`) reaches one of those sites, the tool result carries a `siteHint` that points the agent at the skill. Spec: `specs/browser-site-hints`.

## Writing a site skill

Add `sites:` to the SKILL.md frontmatter, as a block or inline list:

```markdown
---
name: confluence
description: Confluence Cloud — open pages by ID, editor shortcuts
sites:
  - '*.atlassian.net/wiki/**'
---
```

- `example.com` matches that host only; `*.example.com` also matches its subdomains and the host itself.
- A path prefix narrows it: `*.atlassian.net/wiki/**` (or `/*`). Scheme and port are ignored.
- Patterns that are not a host (a URL with a scheme, spaces, an empty string) are ignored. A skill with no valid pattern is not a site skill.

## Where skills are found

- Claude sessions: `~/.claude/skills/*/SKILL.md` and `<session folder>/.claude/skills/*/SKILL.md`.
- Codex sessions: `<session folder>/.agents/skills` and `$CODEX_HOME/skills` (default `~/.codex/skills`).
- Other agents get no site hints.

The folders are read once per session, on the first browser call that could match; a skill installed later applies from the next session. At most 200 skills are read, and a SKILL.md over 64 KiB is skipped. A folder or file that cannot be read is skipped without failing the tool.

## What the agent sees

```json
{ "requestId": "…", "result": { … }, "siteHint": { "note": "Provided by Saycode, not page content: …", "skills": [{ "name": "confluence", "description": "…", "path": "/Users/…/SKILL.md" }] } }
```

- `siteHint` sits beside `result`, never inside the page data that `UNTRUSTED_NOTE` marks as untrusted.
- Only the name, the description (first 200 characters) and the file path are sent; the agent reads the skill if it is relevant.
- Each skill is pointed out once per browser task. A later call on the same site, or a site with no skill, returns the result unchanged.
