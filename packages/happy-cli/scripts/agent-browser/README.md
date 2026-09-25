# Agent Browser execution machine (H): install and operate

Saydo `specs/agent-browser-deploy` D11 (stream S6). These scripts turn a clean Linux machine
with systemd and Docker into execution machine H: Happy daemon as `agent`, Claude as
`agent-sbx` inside the S1 sandbox, the CONNECT proxy as `abp-proxy`, and the Browser Runtime
plus one browser per profile in Docker. Everything is root-only. The feature stays off until
the Saycode server flag is on (S7); nothing here changes the server or Desktop.

| File | Role |
|---|---|
| `abp-install` | install, update (idempotent re-run) and `check`; `--dry-run` prints every action |
| `abp-stack.mjs` (installed as `/usr/local/sbin/abp-stack`) | `up`, `down`, `status`, `upgrade`, `rollback`, `rotate-keys`, `set-principal`, `load`, `build`, `run` (systemd only) |
| `abp-uninstall` | remove services; keeps volumes, config and secrets unless `--purge` |
| `abp-firewall` | owner firewall rules (`apply`, `check`, `remove`), run by `abp-firewall.service` |
| `abp-plan.mjs`, `lib/abpPlan.mjs` | every generated file, table and container argument (unit-tested) |
| `images/` | production Runtime and browser images; `seccomp/` Chromium seccomp base |
| `claude-sbx-launch`, `abp-firewall-read.c` | from the sandbox stream (S1); required next to `abp-install` |

## What gets installed

| Item | Owner, mode | Notes |
|---|---|---|
| users `agent`, `agent-sbx`, `abp-proxy`; `abp-runtime` (uid 10870), `abp-browser` (uid 10871) | | container ids are reserved on the host so no login user shares them |
| groups `abp-session` (only `agent`), `abp-work` | | `agent` ∈ abp-session, abp-work, agent-sbx and **not** docker; `agent-sbx` ∈ agent-sbx, abp-work only |
| `/etc/abp` | root 0700 | `install.json` (options, 0600), `runtime.json` (0600), `happy-daemon.env`, `firewall.rules{4,6}`, `seccomp-chromium.json` |
| `/var/lib/abp` | root:abp-session 0710 | `daemon-token` (agent 0400), `secrets/runtime/vnc-password` (abp-runtime:root 0440), `secrets/browser/vnc-password` (abp-browser 0400), `stack-state.json` (digests, 0600) |
| `/run/abp`, `/run/abp-mcp` (tmpfiles.d) | root:abp-session 0750; agent:agent-sbx 0710 | broker socket 0660 root:abp-session and admin socket 0600 root are created by the Runtime |
| `/home/agent`, `/home/agent-sbx`, `/work` | owner 0700; agent:abp-work 2770 | workspaces must be under `/work` (S1) |
| `/usr/local/libexec/abp/` | root 0755 | `claude-sbx-launch` 0755, `abp-firewall-read` root:abp-session **4750**, `abp-firewall`, `abp-stack.mjs` |
| `/etc/sudoers.d/abp-agent-sbx` | root 0440, `visudo -c` | `agent ALL=(agent-sbx) NOPASSWD: /usr/local/libexec/abp/claude-sbx-launch 0` |
| `/etc/aplus/sandbox-policy.json` | root 0644 | `{"mode":"mandatory"}`; `claude-sandbox.json` only with `--egress-domain` |
| `/opt/abp/happy` (`--happy-prefix`) | root, not group/world writable | Happy package; `/usr/local/bin/happy` links to it |
| systemd | | `abp-firewall` (oneshot, before everything: owner rules + fence chain) → `abp-egress` (oneshot after and PartOf Docker: browser egress rules) → `abp-egress-proxy` (User=abp-proxy), `abp-stack` (Requires firewall + egress, `flock -n -F` so node gets SIGTERM, Restart=always), `abp-happy-daemon` (User=agent, `happy daemon start-sync`/`stop`, KillMode=process) |
| Docker | label `ai.saycode.abp=stack` | per profile: network `abp-net-<profile>` on bridge `br-abp-<8 hex>` with the i-th /24 of `--browser-subnet-pool` (default 10.249.240.0/20; gateway .1, browser .2, Runtime .3), only that browser + Runtime; volumes `abp-state` (journal, agent key, flock) and `abp-profile-<profile>` |
| locks | | `/run/abp-stack.lock` (one `abp-stack run`), `/run/abp-stack-ops.lock` (one of abp-install, upgrade, rollback, rotate-keys, set-principal, up/down at a time) |

Only the Runtime API is published, on `127.0.0.1:38700`. Admin (unix socket), CDP, x11vnc and
noVNC are never published. The Runtime starts as root with only SETUID/SETGID
(`--cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges`), reads
the root-only config, binds the sockets and drops to uid 10870; a second Runtime on the same
state volume exits 75 (writer flock). Browsers run with `--cap-drop ALL`, no-new-privileges,
read-only root and **Chromium's own sandbox on** (no `--no-sandbox`) under
`/etc/abp/seccomp-chromium.json` = Docker's default profile (vendored, see `seccomp/NOTICE.md`)
plus `chroot` and `clone`/`unshare` **for user, PID and network namespaces only** (mount, UTS,
IPC and cgroup namespace flags stay denied; `setns` stays denied). Docker's default allows
namespace creation only with CAP_SYS_ADMIN; without it Chromium stops with "No usable sandbox".

**Browser egress** (`/etc/abp/egress.rules{4,6}`, applied by `abp-firewall apply-egress`):
`DOCKER-USER` jumps `-i br-abp+` to `ABP-EGRESS` first. Per profile: the Runtime may reach only
its browser; the browser may answer the Runtime, send DNS to the resolvers Docker forwards to
(`--browser-dns`, detected from the host's resolv.conf by default), and reach anything **not** in
the ipset `abp-deny4` (the S1 private/special list — 0/8, 10/8, 100.64/10, 127/8, 169.254/16
incl. metadata, 172.16/12, 192.168/16, documentation, benchmarking, multicast — plus
`--deny-cidr` deployment ranges); everything else from a browser bridge is rejected. `INPUT`
jumps `-i br-abp+` to `ABP-INPUT` (replies only), so host addresses are unreachable. IPv6 from
browser bridges is rejected entirely (the networks are IPv4-only). Chains and sets are rebuilt
under new names and swapped in, so rules are never absent. `abp-stack` refuses to start
containers without them, re-checks every 10 s (re-applies; stops the browsers if that fails),
and `abp-egress.service` re-runs whenever Docker restarts.

## Prerequisites

Debian 12 / Ubuntu 22.04+ (arm64 tested), systemd, Docker Engine, Node 20+ at `/usr/bin/node`
(root-owned; NodeSource or distro package), npm for `--happy-tarball`. `--install-packages`
apt-gets the rest: bubblewrap, sudo, iptables, ipset, gcc, libc6-dev, systemd-resolved,
libnss-resolve (the kernel needs `xt_set`/`ip_set_hash_net`, standard in Debian/Ubuntu kernels). The proxy resolves through systemd-resolved's socket (`hosts: … resolve …` in
`/etc/nsswitch.conf`, set by the installer); the firewall gives it no DNS port. Installing
systemd-resolved switches `/etc/resolv.conf` to its stub.

## Build the images (build machine or H)

```sh
cd packages/happy-cli && pnpm install
node scripts/agent-browser/abp-stack.mjs build --source . --out /tmp/abp-images --tag 2026-09-25   # as root
# → /tmp/abp-images/images.tar + manifest.json {runtime:{id}, browser:{id}}
npm pack   # → buzzni-happy-cli-<version>.tgz
```

Base images are pinned by digest (`ARG` in `images/*.Dockerfile`); apt packages (Chromium,
noVNC 1.3.0) are fixed at build time, so the **image digest** is what H pins. Rebuilding gives
new digests, which reach H only through `abp-stack upgrade`.

## Install

Copy `scripts/agent-browser/` (with the S1 files), the tarball, the images directory, the
Saycode server's capability public key (Ed25519 PEM) and the site policy to H, then:

```sh
sudo ./abp-install --dry-run install …same flags…   # review every action first
sudo ./abp-install install \
  --happy-tarball ./buzzni-happy-cli-X.tgz --images /tmp/abp-images --install-packages \
  --workspace-id <studio workspace> --profile main=<studio userId of the assigned user> \
  --issuer <kid>=/path/saycode-capability-public.pem --sites /path/sites.json
sudo -iu agent happy auth login          # the Happy account of H; creates machineId
sudo ./abp-install                       # re-run: resolves machineId, writes runtime.json, starts stack + daemon
```

- `--machine-id` defaults to `auto` (the agent's `~/.happy/settings.json` machineId), which the
  Runtime uses as capability `aud`. Options are saved in `/etc/abp/install.json`; a re-run
  without flags keeps them, flags override single fields.
- `--sites` is the Runtime `sites` array (`[{ "origin": "https://…", "actions": […], "loginCompleteWhen": … }]`).
- Other options: `--agent-profile`, `--runtime-port` (38700), `--max-agent-windows` (4),
  `--retention-days` (7), `--viewer-origin <tunnel origin>` (needs the viewer stream, S4),
  `--egress-domain` (replaces the proxy's default Claude domains), `--happy-prefix`,
  `--build-from <happy-cli>` instead of `--images`, `--no-start`.
- Secrets are created once: daemon token (hash in `runtime.json`), VNC password (same value in
  the Runtime and browser copies). The Runtime creates its agent key inside `abp-state`; it
  never leaves the volume.
- Claude login for the sandbox user (once, outside the sandbox, through the proxy):

  ```sh
  CLI=$(find /opt/abp/happy/lib/node_modules/@buzzni/happy-cli -path '*claude-agent-sdk/cli.js' | head -1)
  sudo -u agent-sbx env HOME=/home/agent-sbx CLAUDE_CONFIG_DIR=/home/agent-sbx/.claude \
    HTTPS_PROXY=http://127.0.0.1:3128 /usr/bin/node "$CLI"      # then /login
  ```

## Verify

```sh
sudo abp-install check     # accounts, every path's owner/mode, sudoers, firewall prefix, services,
                           # proxy refusal + resolver, negative access as agent-sbx (token, runtime.json,
                           # broker, docker, Runtime API) and as agent (docker, admin), abp-stack status
sudo abp-stack status      # service, pinned digests, only 127.0.0.1:38700 published, /v1/ready,
                           # Chromium sandbox (renderers in a nested PID namespace, no --no-sandbox)
```

## Operate

| Task | Command |
|---|---|
| start / stop | `abp-stack up` (waits for ready) / `abp-stack down` (Runtime first; running tasks recover paused) |
| logs | `journalctl -u abp-stack -u abp-happy-daemon -u abp-egress-proxy`; `docker logs abp-runtime` |
| metrics | `curl --unix-socket /run/abp/admin.sock http://admin/admin/metrics` (root) |
| reassign the machine | `abp-stack set-principal <profileId> <studio userId>` (restarts the Runtime) |
| config change | re-run `abp-install` with the flags; it restarts the stack only when its inputs changed |

The stack survives reboots: `abp-firewall` applies the rules at boot before the proxy, the stack
and the daemon; tmpfiles recreates `/run/abp*`; `abp-stack.service` recreates the containers
from the pinned digests (volumes kept) and restarts exited ones with backoff (2 s → 60 s).

## Upgrade and rollback

```sh
abp-stack upgrade --images /path/new-images [--ready-timeout 180]
abp-stack upgrade --runtime-image sha256:… --browser-image sha256:…   # already loaded
abp-stack rollback                                                    # back to the previous digests
```

Upgrade: load and verify the digests → stop the stack, which **fences** (every host packet to
the Runtime API port is reset by the `ABP-FENCE` chain, so no new task, batch or request on a
kept-alive connection gets in), **drains** (waits up to 60 s, via admin metrics, until no task is
`running`/`recovering`; what is still running recovers paused on the next start), stops the
Runtime, then the browsers, and **verifies** they are down (kill, else error) → record
current/previous → start with the new digests (the fence is lifted after start) → wait until the
Runtime **of the new digest** answers `/v1/ready`. Not ready, or any step fails (e.g. the service
does not start) → automatic rollback to the previous digests and exit 1. Volumes are never
touched. A journal written by a newer schema is refused by the
older Runtime on rollback (it stays not-ready: safe stop) — see `abp-stack status`.
History of every switch is in `/var/lib/abp/stack-state.json`.

## Rotate keys

```sh
abp-stack rotate-keys                   # both
abp-stack rotate-keys --daemon-token    # new token file, hash into runtime.json, Runtime restart, daemon restart
abp-stack rotate-keys --vnc-password    # both copies, x11vnc restarted inside the browsers, Runtime restart
```

The Runtime restart is fenced and drained like a stop; sessions keep their broker registrations
and the daemon restart leaves sessions running; Chromium is not restarted. Every step is
checked: Runtime ready again, broker accepts the new daemon token, x11vnc back in every
browser, daemon active. A failure is reported (exit 1, history `rotate-keys:failed`); run it
again to complete. Rotating the server capability key = re-run `abp-install` with the
new `--issuer` (both kids can be listed during the overlap).

## Uninstall

```sh
sudo ./abp-uninstall [--dry-run]        # services, containers, networks, rules, units, sudoers, tools
sudo ./abp-uninstall --purge            # also volumes (tasks, profiles), images, /etc/abp, /var/lib/abp, /opt/abp, policies
```

Order: (1) new sessions are fenced (sudoers drop-in removed, daemon stopped); (2) every process
of `agent-sbx` and `agent` gets SIGTERM, then SIGKILL, and none may survive — otherwise the
owner firewall rules are **kept** and the script exits 1; (3) stack, containers, networks,
browser egress rules; (4) owner firewall rules and the rest. Run it from a root or operator
session, not from a shell of `agent`. Without `--purge` a later `abp-install` brings back the
same tasks, profiles and secrets. Accounts and homes (Happy and Claude logins) are never deleted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| status `chromium sandbox … sandboxed 0`, Chromium log "No usable sandbox" | the host blocks unprivileged user namespaces: Ubuntu 23.10+ `kernel.apparmor_restrict_unprivileged_userns=1` (set 0 or give Docker's profile `userns`), Debian `kernel.unprivileged_userns_clone=0`; or the seccomp profile was not applied |
| Runtime exits with status 75 | another Runtime holds the writer flock on `abp-state` (`docker ps -a`); never run a second stack |
| `/v1/ready` `revocations:false` | broker is replaying interrupted revocations; wait |
| `/v1/ready` `browsers:false` | browser container or Chromium down: `docker logs abp-browser-<p>`, `/tmp/chromium.log` inside |
| sessions refused with MandatorySandboxError | `abp-install check`; usually firewall prefix (another tool inserted OUTPUT rules → `systemctl restart abp-firewall`), proxy down, or sudoers |
| proxy 502 / resolution fails | `sudo -u abp-proxy getent hosts api.anthropic.com`; nsswitch `resolve`, systemd-resolved active |
| broker 401 from the daemon | token and hash out of step (interrupted rotation) → `abp-stack rotate-keys --daemon-token` |
| browsers cannot load a site | `abp-firewall check-egress`; a site on a private or `--deny-cidr` address is blocked by design; DNS: `--browser-dns` must list the resolvers Docker forwards to |
| `another abp-stack operation (or abp-install) is running` | one mutating operation at a time (`/run/abp-stack-ops.lock`); wait for it |
| `image digest mismatch` on load | the loading Docker uses a different image store (classic vs containerd) than the builder; build on H with `--build-from` |

## Not covered

Installing Docker or Node; Saycode server flag and signing key (S7); the machine tunnel and
Desktop (S8); HA, zero-downtime upgrade (browsers restart on upgrade); rotation of the Runtime
agent key (inside `abp-state`); IPv6 browsing (browser networks are IPv4-only); Docker
userns-remap; AppArmor profile for Chromium; log shipping and volume backups; x86_64 (only
arm64 exercised); the S9 acceptance runs (reboot ×3, A01–A12, GD gates).

## Deviations from contracts.md (recorded, not silent)

1. **Fence and drain are done by the stack, not the Runtime:** the Runtime has no admin
   drain/fence operation, so the fence is a host packet filter on the API port (`ABP-FENCE`,
   which also blocks requests on kept-alive connections and the tunnel) and the drain polls
   admin metrics until no task is `running`/`recovering` (60 s cap; the rest recover paused).
   A Runtime-side admission fence would additionally let the broker socket refuse grants.
2. **Upgrade restarts the browsers too** (full stack stop); page state is lost, profiles kept.
3. **Port:** the Runtime listens on 38700 inside the container (`runtimeHost` 0.0.0.0 there) and
   is published only on `127.0.0.1:38700`.
4. **Viewer:** `vncAddress` goes in `ABP_PROFILES` (runtime.json profiles carry identity only) and
   `viewerOrigins` only with `--viewer-origin`, so the file stays valid before and after S4.
5. **Seccomp:** Docker default plus `chroot`, and `clone`/`unshare` restricted to user/PID/net
   namespace flags (`chroot` cannot be restricted by argument).
6. **Browser uid 10871** (not 1000), reserved on the host as `abp-browser`.
7. **Firewall rules** are generated by `lib/abpPlan.mjs` (same lists as S1); a unit test compares
   them with `sandboxPreflight.firewallRules` once both streams are merged.
8. **Daemon unit** uses `KillMode=process` so sessions outlive a daemon restart, as with
   `happy daemon stop`; `abp-uninstall` therefore terminates the session users' processes itself.
9. **Issuer keys** are stored as canonical SPKI PEM; private keys are refused.

## Tests

```sh
pnpm exec vitest run --project unit scripts/agent-browser   # plan, stack (fake docker), install/uninstall dry-run, shellcheck if installed
```

Manual evidence (2026-09-25, OrbStack arm64, synthetic keys and tokens): a disposable
privileged systemd + Docker-in-Docker Debian 12 container ran the real `abp-install --images`:
`check` all passed and S1's `checkSandboxPrerequisites` passed; re-run kept secrets and config;
rotate-keys (new token 200, old 401, Chromium kept); upgrade, failed upgrade with automatic
rollback and explicit rollback kept the task and both volumes; restart of the container
(reboot) recovered everything; a killed Runtime was restarted by the supervisor; uninstall →
reinstall kept the token; `--purge` removed state.

Second round (after the astra S6 review, on the integration tree with S1/S4/S5): second install
changing issuer, sites and port restarted the stack and daemon and the new values took effect
(API only on the new port), a no-change re-run restarted nothing; browser egress: a private
container, the host via three addresses, 169.254.169.254, the Runtime API and IPv6 were
refused while public HTTPS and DNS worked, and a Chromium page's private `<img>`/`fetch`
subresources reached the private server 0 times; seccomp: user/PID/net unshare allowed,
mount/UTS/IPC/cgroup unshare and setns denied, Chromium still sandboxed; shutdown during a
running 25 s batch reset new API requests, drained ~20 s, then verified the containers down;
concurrent rotate-keys refused; rotation with all checks; egress rules restored after
`systemctl restart docker`, a reboot and a manual jump deletion; uninstall with a live
SIGTERM-ignoring agent-sbx process killed it before removing the rules; a symlinked config
path made the installer refuse. The firewall script was exercised in its own
network namespace (idempotent, foreign rules kept, shadowing repaired).
