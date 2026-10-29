# Browser space management and resource admission

The runtime owns space lifecycle and admission; the console only invokes scoped interactive operations.
`listSpaces`, `closeSpace` and `setSpaceQuota` must be explicitly included in the interactive capability.
Agents cannot change quota preferences. Existing capabilities and fixed-config installations remain compatible.

`adaptiveSpaceQuota` defaults to true for runtime.json installations. The browser image's internal
instance endpoint exposes `/resources` from **Chromium's own cgroup v2**, not the runtime cgroup.
No Docker socket, host mount or new privilege is required. Old images and unsupported controllers
fail closed to installed fixed limits. Sampling runs every 10 seconds with a 2-second timeout;
readings older than 30 seconds cannot justify growth.

The admission ceiling is 16. Each additional window reserves 256 MiB, with 256 MiB retained in the
browser and 2 GiB on the host. Memory, CPU allocation (four windows per core), measured CPU usage
(90% saturation stops growth), and PID headroom (16 reserve, eight per window) all bound admission.
These are conservative admission estimates, not guaranteed page-memory limits; cgroups remain the
hard enforcement boundary. Revisit the constants with representative Chromium workload measurements.
Repeated fresh samples raise the ceiling by two. New windows remain reserved until the next sample;
other profiles' spaces are also reserved against host headroom. Pressure only limits new work and
never evicts existing spaces. Physical container allocations remain unchanged.

Automatic/null or manual/1..16 preferences persist in spaces.json with a compare-and-set revision.
The key contains profile, principal and assignment, so a reassigned profile does not inherit its old
owner's preference. A profile's quota applies across its owner's organizations; listSpaces exposes
only scoped spaces plus aggregate usage outside the list. Actual open usage includes reclaiming
spaces; `reclaimingReserve` explains the existing admission exemption (at most two).

A manual setting is a ceiling, not a reservation or an override of resource safety. Setting 12 on a
browser with safe capacity 8 yields effective capacity 8. No restart is required. Setting
`adaptiveSpaceQuota:false` restores operator-configured fixed admission; it does not close spaces.

Runtime QUOTA_EXCEEDED errors carry a typed quotaKind (spaces/tabs/windows/time/journal). Claude and
Codex protocol mappers preserve it on the optional tool-call-end.browserQuotaKind field. Consumers
must match a browser tool, not prose or page content. Resending a whole user request is never automatic:
review the prior results because earlier actions in that request may already have completed.

Rollout needs matching server allowlist, runtime/CLI, browser image and Desktop. Publish/deploy and
container resizing are separate operations; this source change performs neither. Older servers keep
the legacy operation defaults; Desktop probes the runtime marker before requesting new operations
and retries legacy issuance only for HTTP 400, never for authorization failures.
