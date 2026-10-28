# Session Protocol

This document defines the unified message protocol for Happy sessions. It replaces the existing mix of `output`, `codex`, and custom `acp` formats with a single, flat event stream. Old sessions continue using legacy formats; new sessions use this protocol exclusively.

For context on the existing wire protocol (WebSocket transport, encryption, sequencing), see `protocol.md`.

## Comparison with ACP

The real [Agent Communication Protocol](https://agentcommunicationprotocol.dev) is an agent-to-agent interoperability standard over REST. Our protocol solves a different problem: rendering encrypted agent chat sessions on mobile/web clients.

| Concern | ACP | This protocol |
|---|---|---|
| Purpose | Agent-to-agent interop (REST) | Encrypted chat with agent sessions |
| Transport | REST + SSE | Encrypted payloads over WebSocket |
| Message model | `Message { role, parts[] }` with MIME types | Flat event stream, discriminated by `t` |
| Content typing | MIME types (`text/plain`, `image/png`) | Explicit event types (`text`, `service`, `file`, etc.) |
| Files | `content_url` or base64 with MIME type | Upload-first, referenced by `ref` |
| Images | Same as files (MIME-typed part) | `file` event with optional image metadata (`width`, `height`, `thumbhash`) |
| Tool calls | TrajectoryMetadata on parts | First-class `tool-call-start` / `tool-call-end` |
| Lifecycle | 7 run states, 11 SSE event types | `turn-start` / `turn-end` + agent `start` / `stop` |
| Event identity | UUID on runs, created_at on messages | `id` (cuid2) + `time` (ms) on every message |

**Why not ACP directly?**

1. **Encryption** — ACP assumes plaintext REST. Our payloads are end-to-end encrypted.
2. **Tool calls are UI-visible** — ACP models tools as metadata for debugging. We render them with spinners, descriptions, and permission dialogs.
3. **Instant image rendering** — ACP has no thumbhash or dimensions. Our `file` event can carry image metadata for instant placeholder layout.
4. **Simplicity** — 9 event types total. A client implements the full protocol in a single `switch`.

**What we take from ACP:**

- Role on the envelope (`user` / `agent`)
- Content by reference (`content_url` → `ref`)
- Separation of lifecycle events from content events

## Envelope

Every encrypted message payload:

```json
{
  "id": "<cuid2>",
  "time": 1739347200000,
  "role": "user" | "agent",
  "turn": "<cuid2>",
  "subagent": "<cuid2>",
  "ev": { "t": "...", ... }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | cuid2 | Globally unique message identifier |
| `time` | number | Unix timestamp in milliseconds |
| `role` | `"user"` \| `"agent"` | Who produced this event |
| `turn` | cuid2? | Turn id established by `turn-start`. Required on all agent messages; agent messages without `turn` are ignored |
| `subagent` | cuid2? | Optional. Subagent identifier for messages produced by a subagent. Must be adapter-generated cuid2 |
| `ev` | object | Event body, discriminated by `ev.t` |

## Subagents

When a tool call spawns a subagent (e.g. a Task tool), all messages produced by that subagent carry `subagent` set to an adapter-generated cuid2 id. Parent provider tool-call envelopes are optional; adapters may hide parent tool-call noise and emit only subagent lifecycle/content.

Subagents can nest — a subagent's tool call can spawn another subagent. Each level uses its own `subagent` id.

For provider adapters, orphan handling is a CLI responsibility: if a subagent message arrives before its parent subagent registration, the CLI should buffer and emit it only after the parent is known.

Provider-native ids (Claude/Codex tool ids, etc.) must not be used as `subagent` values.

**Codex sub-agents.** Codex child threads are not sent as `subagent` messages. The CLI keeps their notifications out of the main turn, the transcript and the stream preview. For each child the main thread spawns inside a turn, it adds only one pair to that turn: a `tool-call-start` (`name: "CodexAgent"`; `title`, `description` and `args.agent` are the child's name) immediately followed by its `tool-call-end`; the pair's call id is the child thread id, and neither carries a `backgroundTaskId` (that would read as a Claude background launch whose completion answers the request again). The children running now are listed in the session metadata `codexSubagentTasks` (`{ startedAt, available, tasks: [{ taskId, label, kind: "agent" }] | null }`, replaced as a whole on every publish). A session whose runtime never listed a child gets no such key: an empty or unavailable list is written only after a list was, or to replace one an earlier runtime left. Because `taskId` equals the row's call id, a client can show the row as running while the child is listed. Full contract: [specs/codex-subagent-activity](../specs/codex-subagent-activity/spec.md).

## Events

### `text`

Text content displayed to the user. Supports markdown.

```json
{ "t": "text", "text": "Hello, how can I help?" }
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Message text (markdown) |
| `thinking` | boolean? | Optional. `true` if this is internal reasoning, not shown to user by default |

### `service`

Agent-only service text shown to the user as-is. Supports markdown.

```json
{ "t": "service", "text": "**Service:** reconnecting..." }
```

| Field | Type | Description |
|---|---|---|
| `text` | string | Service message text (markdown) |

### `tool-call-start`

Agent begins a tool invocation.

```json
{
  "t": "tool-call-start",
  "call": "tc_abc",
  "name": "grep",
  "title": "Searching for handleClick",
  "description": "Searching for `handleClick` in **src/** directory",
  "args": { "pattern": "handleClick", "path": "src/" }
}
```

| Field | Type | Description |
|---|---|---|
| `call` | string | Tool call identifier, matched by `tool-call-end` |
| `name` | string | Tool name (lowercase, hyphenated); provider adapters also use prefixed names (`CodexBash`, `CodexPatch`, `CodexAgent`) |
| `title` | string | Short summary (inline markdown: `` `code` ``, **bold**, *italic*, [links]) |
| `description` | string | Full description (inline markdown: `` `code` ``, **bold**, *italic*, [links]) |
| `args` | object | Tool input arguments |

### `tool-call-end`

Tool invocation completes. Matches a prior `tool-call-start` by `call`.

```json
{ "t": "tool-call-end", "call": "tc_abc" }
```

| Field | Type | Description |
|---|---|---|
| `call` | string | Matches `tool-call-start.call` |
| `images` | array? | Optional. Image blocks of the tool result (e.g. Read on an image file), each `{ mediaType, data }` with base64 `data`. They ride inline on this event instead of a separate upload; consumers that only read `call` are unaffected |
| `backgroundTaskId` | string? | Optional. The detached job a Claude `run_in_background` launch created: later reports about that job carry this id, never the tool call id, and its completion answers the request again. Transport metadata, never rendered. A Codex `CodexAgent` row never carries it |

### `file`

File attachment. The file must be uploaded to the server first.

```json
{ "t": "file", "ref": "upload_def", "name": "report.pdf", "size": 524288 }
```

| Field | Type | Description |
|---|---|---|
| `ref` | string | Server upload ID |
| `name` | string | Display filename |
| `size` | number | Required file size in bytes |
| `image` | object? | Optional image metadata when the file is an image |
| `image.width` | number | Image width in pixels |
| `image.height` | number | Image height in pixels |
| `image.thumbhash` | string | Base64-encoded [ThumbHash](https://evanw.github.io/thumbhash/) for instant placeholder |

### `turn-start`

Agent begins processing. Always `role: "agent"`. The envelope includes a `turn` id (cuid2) that identifies the turn. This `turn` value must be treated as the turn identifier; it is separate from message `id`.

```json
{ "id": "a2", "turn": "t2", "ev": { "t": "turn-start" } }
```

### `turn-end`

Agent finishes processing. Always `role: "agent"`. Carries the same `turn` as the messages it closes.

```json
{ "t": "turn-end", "status": "completed" }
```

| Field | Type | Description |
|---|---|---|
| `status` | `"completed"` \| `"failed"` \| `"cancelled"` | Final turn outcome |

### `start`

Agent lifecycle marker for subagent start. Always `role: "agent"`. Use envelope `subagent` to identify which subagent started.

```json
{ "t": "start", "title": "Research agent" }
```

| Field | Type | Description |
|---|---|---|
| `title` | string? | Optional human-readable title for the subagent |

### `stop`

Agent lifecycle marker for subagent stop. Always `role: "agent"`. Use envelope `subagent` to identify which subagent stopped.

```json
{ "t": "stop" }
```

## Example stream

```
← { id: "a1", time: 1000, role: "user",  ev: { t: "text", text: "Find TODOs" } }
← { id: "a2", time: 1001, role: "agent", turn: "t2", ev: { t: "turn-start" } }
← { id: "a2b", time: 1001, role: "agent", turn: "t2", ev: { t: "service", text: "**Service:** connected to remote runtime" } }
← { id: "a3", time: 1002, role: "agent", turn: "t2", ev: { t: "text", text: "Searching..." } }
← { id: "a4", time: 1003, role: "agent", turn: "t2", ev: { t: "tool-call-start", call: "tc1", name: "grep", title: "Searching for TODO", description: "Searching for `TODO` in project root", args: { pattern: "TODO" } } }
← { id: "a5", time: 1004, role: "agent", turn: "t2", ev: { t: "tool-call-end", call: "tc1" } }
← { id: "a6", time: 1005, role: "agent", turn: "t2", ev: { t: "text", text: "Found 3 TODOs." } }
← { id: "a7", time: 1006, role: "agent", turn: "t2", ev: { t: "turn-end", status: "completed" } }
```

The `turn-start` at `a2` establishes `turn: "t2"`. All subsequent agent messages carry that `turn` value, including the `turn-end`.

Agent spawning a subagent:

```
← { id: "c1", time: 3000, role: "agent", turn: "t2", ev: { t: "tool-call-start", call: "tc2", name: "task", title: "Exploring codebase", description: "Searching for **auth** implementations", args: { prompt: "Find auth code" } } }
← { id: "c2", time: 3001, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "start", title: "Auth explorer" } }
← { id: "c3", time: 3002, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "text", text: "Looking at src/auth/..." } }
← { id: "c4", time: 3003, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "tool-call-start", call: "tc3", name: "grep", title: "Searching for login", description: "Searching for `login` in **src/auth/**", args: { pattern: "login" } } }
← { id: "c5", time: 3004, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "tool-call-end", call: "tc3" } }
← { id: "c6", time: 3005, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "text", text: "Found auth handler." } }
← { id: "c7", time: 3006, role: "agent", turn: "t2", subagent: "v8x9j2q7k1n4m5p6r3s0t1u2", ev: { t: "stop" } }
← { id: "c8", time: 3007, role: "agent", turn: "t2", ev: { t: "tool-call-end", call: "tc2" } }
```

All messages carry `turn: "t2"` — they all belong to the same turn. Messages `c2`–`c7` also carry the same cuid2 `subagent` value, linking them to the same subagent.

User sending an image file:

```
← { id: "b1", time: 2000, role: "user", ev: { t: "file", ref: "up_1", name: "screenshot.png", size: 153249, image: { width: 800, height: 600, thumbhash: "..." } } }
← { id: "b2", time: 2001, role: "user", ev: { t: "text", text: "What's in this screenshot?" } }
```

## Design rules

1. **Flat stream** — no nesting; tool boundaries are markers in the stream
2. **Upload-first** — files are uploaded to the server, then referenced by `ref`
3. **Every message has identity** — `id` (cuid2) + `time` (ms) on the envelope
4. **9 event types** — simple `switch(ev.t)` in any client
5. **Provider-agnostic** — no agent backend leaks into the protocol
6. **Consistent naming** — all `kebab-case`, no mixed conventions
7. **Inline markdown** — `title` and `description` support `` `code` ``, **bold**, *italic*, [links]

## Example ID shorthand

Examples in this document may use short placeholder ids (for readability), but protocol values must still satisfy schema rules:
- `id`: cuid2
- `turn`: cuid2 (when present)
- `subagent`: cuid2 (when present)
