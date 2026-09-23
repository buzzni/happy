# Native daemon session state

Replace shell-based daemon listing with encrypted machine RPC `daemon-session-state`.
Request: `{sessionId: string}`. Response: `{version: 1, state: "present" | "missing" | "unknown"}`.
Read only the current tracked daemon children used by `/list`, never archived resume records.
Advertise `daemonSessionState: {version: 1}` on supported BYOS daemons.
Retain managed restrictions and all existing authentication boundaries.
Invalid requests and uncertain observations return `unknown`; no mutations or shell commands.
