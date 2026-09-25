// Agent Browser execution machine H: everything abp-install and abp-stack
// generate (install options, /etc/abp/runtime.json, permissions, owner firewall
// rules, sudoers, tmpfiles, systemd units, seccomp profile, container
// arguments). Pure functions, no I/O, no dependency beyond node:crypto, so the
// installed copy runs with /usr/bin/node alone and the unit tests pin it.
// Errors name the field, never the value (issuer keys, tokens).
import { createPublicKey } from "node:crypto";

export const DEFAULT_RUNTIME_PORT = 38700;
export const PACKAGE_NAME = "@buzzni/happy-cli";
/** Fixed ids of the container users; host accounts reserve them so no login user shares them. */
export const IDS = { runtimeUid: 10870, browserUid: 10871 };
export const PATHS = {
  etc: "/etc/abp",
  installConfig: "/etc/abp/install.json",
  runtimeConfig: "/etc/abp/runtime.json",
  daemonEnv: "/etc/abp/happy-daemon.env",
  seccompProfile: "/etc/abp/seccomp-chromium.json",
  firewallRules: { 4: "/etc/abp/firewall.rules4", 6: "/etc/abp/firewall.rules6" },
  varLib: "/var/lib/abp",
  daemonToken: "/var/lib/abp/daemon-token",
  secrets: "/var/lib/abp/secrets",
  runtimeSecrets: "/var/lib/abp/secrets/runtime",
  browserSecrets: "/var/lib/abp/secrets/browser",
  stackState: "/var/lib/abp/stack-state.json",
  run: "/run/abp",
  brokerSocket: "/run/abp/broker.sock",
  adminSocket: "/run/abp/admin.sock",
  mcp: "/run/abp-mcp",
  work: "/work",
  libexec: "/usr/local/libexec/abp",
  launcher: "/usr/local/libexec/abp/claude-sbx-launch",
  firewallReader: "/usr/local/libexec/abp/abp-firewall-read",
  stackBin: "/usr/local/sbin/abp-stack",
  aplus: "/etc/aplus",
  sandboxPolicy: "/etc/aplus/sandbox-policy.json",
  egressPolicy: "/etc/aplus/claude-sandbox.json",
  sudoers: "/etc/sudoers.d/abp-agent-sbx",
  tmpfiles: "/etc/tmpfiles.d/abp.conf",
  units: "/etc/systemd/system",
  happyPrefix: "/opt/abp/happy",
  stackLock: "/run/abp-stack.lock",
};
/** Container-side paths (fixed by the images). */
const IN_CONTAINER = { secrets: "/run/secrets/abp", vncPassword: "/run/secrets/abp/vnc-password", state: "/var/lib/abp", stateDir: "/var/lib/abp/state", profile: "/home/browser/profile" };
export const STACK_LABEL = "ai.saycode.abp=stack";

// Same lists as src/sandbox/egressProxy.ts (S1); abpPlan.test.ts compares with the preflight once both are in the tree.
const DENIED_IPV4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"];
const DENIED_IPV6 = ["2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20"];

const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,30}$/;
const TEXT_ID = /^[^\u0000-\u001f\u007f]{1,256}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

function fail(field, message) {
  throw new Error(`abp install option ${field}: ${message}`);
}
function bareOrigin(value, field) {
  let url;
  try { url = new URL(value); } catch { fail(field, "must be a bare origin such as https://shop.example"); }
  if (url.origin !== value || !["https:", "http:"].includes(url.protocol)) fail(field, "must be a bare origin such as https://shop.example");
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) fail(field, `must be an integer ${min}..${max}`);
  return value;
}

/**
 * Install options (/etc/abp/install.json, no secrets) = the saved options with
 * the given flags applied. Validated as a whole, so a re-run without flags
 * keeps the machine as it was and a partial change cannot leave it invalid.
 * `machineId: "auto"` is resolved later from the agent's Happy settings.
 */
export function mergeInstallOptions(saved, flags) {
  const merged = {
    schemaVersion: 1,
    runtimePort: DEFAULT_RUNTIME_PORT,
    maxAgentWindows: 4,
    retentionDays: 7,
    viewerOrigins: [],
    egressDomains: [],
    sites: [],
    happyPrefix: PATHS.happyPrefix,
    ...saved,
    ...Object.fromEntries(Object.entries(flags).filter(([key, value]) => value !== undefined && key !== "issuers")),
  };
  if (flags.issuers !== undefined) merged.trustedIssuers = flags.issuers;
  if (!merged.agentProfileId || (flags.profiles && !flags.agentProfileId && !flags.profiles.some((p) => p.profileId === merged.agentProfileId))) {
    merged.agentProfileId = merged.profiles?.[0]?.profileId;
  }
  if (merged.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  for (const field of ["machineId", "workspaceId"]) {
    if (typeof merged[field] !== "string" || !TEXT_ID.test(merged[field])) fail(field, "is required (1-256 printable characters)");
  }
  if (!Array.isArray(merged.profiles) || merged.profiles.length === 0) fail("profiles", "at least one --profile <id>=<principalId> is required");
  const seen = new Set();
  for (const [index, profile] of merged.profiles.entries()) {
    if (!PROFILE_ID.test(profile?.profileId ?? "")) fail(`profiles[${index}].profileId`, "must be lowercase letters, digits and hyphens (max 31), it names containers and volumes");
    if (!TEXT_ID.test(profile.principalId ?? "")) fail(`profiles[${index}].principalId`, "is required");
    if (seen.has(profile.profileId)) fail(`profiles[${index}].profileId`, "is duplicated");
    seen.add(profile.profileId);
  }
  merged.profiles = merged.profiles.map(({ profileId, principalId }) => ({ profileId, principalId }));
  if (!seen.has(merged.agentProfileId)) fail("agentProfileId", "must be one of the configured profiles");
  if (!Array.isArray(merged.trustedIssuers) || merged.trustedIssuers.length === 0) fail("trustedIssuers", "at least one --issuer <kid>=<public-key.pem> is required");
  merged.trustedIssuers = merged.trustedIssuers.map((issuer, index) => {
    if (!TEXT_ID.test(issuer?.kid ?? "")) fail(`trustedIssuers[${index}].kid`, "is required");
    let type;
    try { type = createPublicKey(issuer.publicKeyPem).asymmetricKeyType; } catch { type = undefined; }
    if (type !== "ed25519" || issuer.publicKeyPem.length > 4096) fail(`trustedIssuers[${index}].publicKeyPem`, "must be an Ed25519 public key (PEM)");
    return { kid: issuer.kid, publicKeyPem: issuer.publicKeyPem };
  });
  if (!Array.isArray(merged.sites)) fail("sites", "must be a JSON array of site policies");
  merged.sites.forEach((site, index) => bareOrigin(site?.origin, `sites[${index}].origin`));
  integer(merged.runtimePort, "runtimePort", 1024, 65535);
  integer(merged.maxAgentWindows, "maxAgentWindows", 1, 16);
  integer(merged.retentionDays, "retentionDays", 1, 365);
  merged.viewerOrigins.forEach((origin, index) => bareOrigin(origin, `viewerOrigins[${index}]`));
  if (merged.egressDomains.length > 64) fail("egressDomains", "at most 64");
  merged.egressDomains.forEach((domain, index) => { if (!DOMAIN.test(domain)) fail(`egressDomains[${index}]`, "must be an exact lowercase domain (no wildcard)"); });
  // The sandbox launcher and preflight require root-owned, non-writable executables outside private homes and /tmp.
  if (!/^\/[A-Za-z0-9._/-]+$/.test(merged.happyPrefix) || /(^|\/)\.\.?(\/|$)/.test(merged.happyPrefix) || /^\/(home|tmp|var\/tmp|root|work|run)(\/|$)/.test(merged.happyPrefix)) {
    fail("happyPrefix", "must be an absolute root-owned location outside /home, /root, /tmp, /var/tmp, /run and /work");
  }
  return merged;
}

/** /etc/abp/runtime.json (S2 runtimeConfig schema). Profiles carry identity only; the stack passes endpoints in ABP_PROFILES. */
export function runtimeConfig(install, { sessionGid, daemonTokenSha256 }) {
  if (!/^[0-9a-f]{64}$/.test(daemonTokenSha256 ?? "")) fail("daemonTokenSha256", "must be the hex SHA-256 of the daemon token");
  integer(sessionGid, "abp-session gid", 1, 2 ** 31 - 1);
  return {
    schemaVersion: 1,
    authMode: "production",
    machineId: install.machineId,
    workspaceId: install.workspaceId,
    profiles: install.profiles.map(({ profileId, principalId }) => ({ profileId, principalId })),
    trustedIssuers: install.trustedIssuers,
    sites: install.sites,
    // Inside the container; the stack publishes it on 127.0.0.1 only, same port number.
    runtimeHost: "0.0.0.0",
    runtimePort: install.runtimePort,
    brokerSocketPath: PATHS.brokerSocket,
    adminSocketPath: PATHS.adminSocket,
    brokerSocketGid: sessionGid,
    daemonTokenSha256,
    ...install.viewerOrigins.length ? { viewerOrigins: install.viewerOrigins } : {},
    maxAgentWindows: install.maxAgentWindows,
    retentionDays: install.retentionDays,
  };
}

/**
 * Every path abp-install owns, with owner, group and mode. abp-install applies
 * and checks this table; `secret` rows are generated only when missing.
 * type: dir | file (content written by the installer) | secret | exec | tmpfs-dir (tmpfiles.d)
 */
export function permissionTable() {
  const row = (path, type, owner, group, mode, extra = {}) => ({ path, type, owner, group, mode, ...extra });
  return [
    row(PATHS.etc, "dir", "root", "root", "0700"),
    row(PATHS.installConfig, "file", "root", "root", "0600"),
    row(PATHS.runtimeConfig, "file", "root", "root", "0600"),
    row(PATHS.daemonEnv, "file", "root", "root", "0644"),
    row(PATHS.seccompProfile, "file", "root", "root", "0644"),
    row(PATHS.firewallRules[4], "file", "root", "root", "0644"),
    row(PATHS.firewallRules[6], "file", "root", "root", "0644"),
    // agent traverses to its token (abp-session); agent-sbx cannot enter.
    row(PATHS.varLib, "dir", "root", "abp-session", "0710"),
    row(PATHS.daemonToken, "secret", "agent", "agent", "0400", { secret: true }),
    row(PATHS.secrets, "dir", "root", "root", "0711"),
    // Readable by the Runtime both before (root, via group 0) and after it drops to uid 10870.
    row(PATHS.runtimeSecrets, "dir", "abp-runtime", "root", "0550"),
    row(`${PATHS.runtimeSecrets}/vnc-password`, "secret", "abp-runtime", "root", "0440", { secret: true }),
    row(PATHS.browserSecrets, "dir", "abp-browser", "abp-browser", "0500"),
    row(`${PATHS.browserSecrets}/vnc-password`, "secret", "abp-browser", "abp-browser", "0400", { secret: true }),
    row(PATHS.stackState, "file", "root", "root", "0600"),
    row(PATHS.run, "tmpfs-dir", "root", "abp-session", "0750"),
    row(PATHS.mcp, "tmpfs-dir", "agent", "agent-sbx", "0710"),
    row("/home/agent", "dir", "agent", "agent", "0700"),
    row("/home/agent-sbx", "dir", "agent-sbx", "agent-sbx", "0700"),
    row(PATHS.work, "dir", "agent", "abp-work", "2770"),
    row(PATHS.libexec, "dir", "root", "root", "0755"),
    row(PATHS.launcher, "exec", "root", "root", "0755"),
    row(PATHS.firewallReader, "exec", "root", "abp-session", "4750"),
    row(`${PATHS.libexec}/abp-firewall`, "exec", "root", "root", "0755"),
    row(`${PATHS.libexec}/abp-stack.mjs`, "exec", "root", "root", "0644"),
    row(`${PATHS.libexec}/lib/abpPlan.mjs`, "exec", "root", "root", "0644"),
    row(PATHS.stackBin, "exec", "root", "root", "0755"),
    row(PATHS.aplus, "dir", "root", "root", "0755"),
    row(PATHS.sandboxPolicy, "file", "root", "root", "0644"),
    row(PATHS.sudoers, "file", "root", "root", "0440"),
    row(PATHS.tmpfiles, "file", "root", "root", "0644"),
  ];
}

/** Ordered OUTPUT prefix of src/sandbox/sandboxPreflight.ts firewallRules (S1): installed before every other OUTPUT rule. */
export function firewallRules(family, sandboxUid, proxyUid) {
  const sbx = `-A OUTPUT -m owner --uid-owner ${sandboxUid}`;
  const proxy = `-A OUTPUT -m owner --uid-owner ${proxyUid}`;
  const rules = family === 4 ? [`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${sandboxUid} -m tcp --dport 3128 -j ACCEPT`] : [];
  rules.push(`${sbx} -j REJECT`);
  if (family === 4) rules.push(`-A OUTPUT -d 127.0.0.1/32 -p tcp -m owner --uid-owner ${proxyUid} -m tcp --sport 3128 -m conntrack --ctstate ESTABLISHED -j ACCEPT`);
  for (const cidr of family === 4 ? DENIED_IPV4 : DENIED_IPV6) rules.push(`-A OUTPUT -d ${cidr} -m owner --uid-owner ${proxyUid} -j REJECT`);
  rules.push(`-A OUTPUT${family === 6 ? " -d 2000::/3" : ""} -p tcp -m owner --uid-owner ${proxyUid} -m tcp --dport 443 -j ACCEPT`, `${proxy} -j REJECT`);
  return rules;
}

export function sudoersDropIn() {
  return [
    "# Managed by abp-install. agent may start only the fixed Claude sandbox launcher as agent-sbx.",
    "Defaults:agent env_reset,!use_pty",
    `agent ALL=(agent-sbx) NOPASSWD: ${PATHS.launcher} 0`,
    "",
  ].join("\n");
}

export function tmpfilesConf() {
  return [
    "# Managed by abp-install: Runtime broker/admin sockets and per-session MCP sockets.",
    `d ${PATHS.run} 0750 root abp-session -`,
    `d ${PATHS.mcp} 0710 agent agent-sbx -`,
    "",
  ].join("\n");
}

export function daemonEnv(install) {
  return [
    "# Managed by abp-install. No secret here: the daemon reads its broker token from the file below.",
    `HAPPY_BROWSER_TASK_RUNTIME_URL=http://127.0.0.1:${install.runtimePort}`,
    `HAPPY_BROWSER_TASK_BROKER_SOCKET=${PATHS.brokerSocket}`,
    `HAPPY_BROWSER_TASK_DAEMON_TOKEN_FILE=${PATHS.daemonToken}`,
    `HAPPY_BROWSER_TASK_PROFILE_ID=${install.agentProfileId}`,
    "",
  ].join("\n");
}

export function systemdUnits({ happyPrefix = PATHS.happyPrefix } = {}) {
  const packageDir = `${happyPrefix}/lib/node_modules/${PACKAGE_NAME}`;
  const unit = (lines) => `# Managed by abp-install.\n${lines.join("\n")}\n`;
  return {
    "abp-firewall.service": unit([
      "[Unit]",
      "Description=Agent Browser owner firewall rules (agent-sbx, abp-proxy)",
      "DefaultDependencies=no",
      "After=local-fs.target",
      "Wants=network-pre.target",
      "Before=network-pre.target abp-egress-proxy.service abp-stack.service abp-happy-daemon.service",
      "",
      "[Service]",
      "Type=oneshot",
      "RemainAfterExit=yes",
      `ExecStart=${PATHS.libexec}/abp-firewall apply`,
      `ExecReload=${PATHS.libexec}/abp-firewall apply`,
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-egress-proxy.service": unit([
      "[Unit]",
      "Description=Agent Browser Claude egress proxy (CONNECT, public addresses only)",
      "Requires=abp-firewall.service",
      "After=abp-firewall.service network-online.target systemd-resolved.service",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=abp-proxy",
      "Group=abp-proxy",
      `ExecStart=/usr/bin/node ${packageDir}/dist/sandbox/egressProxyMain.mjs`,
      "Restart=always",
      "RestartSec=2",
      "NoNewPrivileges=yes",
      "CapabilityBoundingSet=",
      "PrivateTmp=yes",
      "ProtectSystem=strict",
      "ProtectHome=yes",
      "PrivateDevices=yes",
      // AF_UNIX: glibc's nss-resolve asks systemd-resolved over its socket (no DNS through the firewall).
      "RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-stack.service": unit([
      "[Unit]",
      "Description=Agent Browser stack (Runtime + one browser per profile)",
      "Requires=docker.service",
      "After=docker.service abp-firewall.service systemd-tmpfiles-setup.service network-online.target",
      "Wants=network-online.target",
      "",
      "[Service]",
      "Type=simple",
      `ExecStart=/usr/bin/flock -n ${PATHS.stackLock} ${PATHS.stackBin} run`,
      // run stops the Runtime first (tasks recover paused), then the browsers.
      "KillMode=mixed",
      "TimeoutStopSec=90",
      "Restart=always",
      "RestartSec=5",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
    "abp-happy-daemon.service": unit([
      "[Unit]",
      "Description=Happy daemon for the Agent Browser execution machine",
      "Requires=abp-firewall.service",
      "Wants=abp-egress-proxy.service abp-stack.service network-online.target",
      "After=abp-firewall.service abp-egress-proxy.service abp-stack.service network-online.target",
      "",
      "[Service]",
      "Type=simple",
      "User=agent",
      "Group=agent",
      "WorkingDirectory=/home/agent",
      "Environment=HOME=/home/agent",
      `EnvironmentFile=${PATHS.daemonEnv}`,
      `ExecStart=${happyPrefix}/bin/happy daemon start-sync`,
      `ExecStop=${happyPrefix}/bin/happy daemon stop`,
      // Sessions outlive a daemon restart, as with `happy daemon stop` outside systemd.
      "KillMode=process",
      "Restart=always",
      "RestartSec=5",
      "UMask=0077",
      "",
      "[Install]",
      "WantedBy=multi-user.target",
    ]),
  };
}

/**
 * Docker's default seccomp profile (vendored, moby/profiles seccomp/v0.2.3)
 * plus the namespace calls of Chromium's own sandbox: it creates a user/PID/net
 * namespace (clone, unshare), chroots its renderers into an empty directory and
 * joins namespaces for its zygote (setns). The default profile allows these only
 * with CAP_SYS_ADMIN, which the container must not have. Everything else stays
 * as in the default, so the only widening is what Chromium needs to sandbox
 * itself instead of running with --no-sandbox.
 */
export function chromiumSeccompProfile(base) {
  if (base?.defaultAction !== "SCMP_ACT_ERRNO" || !Array.isArray(base.syscalls)) throw new Error("seccomp base must be a default-deny profile");
  return {
    ...base,
    syscalls: [
      ...base.syscalls,
      { names: ["chroot", "clone", "setns", "unshare"], action: "SCMP_ACT_ALLOW", comment: "Chromium namespace sandbox without CAP_SYS_ADMIN (abp-install)" },
    ],
  };
}

/** Production layout: one network per profile shared only by that browser and the Runtime. */
export function stackLayout(install) {
  const browsers = install.profiles.map(({ profileId }) => ({
    profileId,
    container: `abp-browser-${profileId}`,
    alias: `browser-${profileId}`,
    network: `abp-net-${profileId}`,
    volume: `abp-profile-${profileId}`,
  }));
  return {
    runtimePort: install.runtimePort,
    networks: browsers.map((browser) => browser.network),
    volumes: ["abp-state", ...browsers.map((browser) => browser.volume)],
    browsers,
    runtime: { container: "abp-runtime", alias: "runtime", networks: browsers.map((browser) => browser.network), volume: "abp-state" },
  };
}

function imageRef(image) {
  if (!IMAGE_ID.test(image ?? "")) throw new Error("image must be a content digest (sha256:<64 hex>)");
  return image;
}

const logOpts = ["--log-driver=json-file", "--log-opt=max-size=10m", "--log-opt=max-file=5"];

/** `docker create` arguments for the Runtime; the other profile networks are connected before start. */
export function runtimeCreateArgs(layout, image) {
  const endpoints = layout.browsers.map((browser) => ({
    profileId: browser.profileId,
    cdpHttpUrl: `http://${browser.alias}:9223`,
    instanceUrl: `http://${browser.alias}:9224/instance`,
    vncAddress: `${browser.alias}:5900`,
  }));
  return [
    "create", `--name=${layout.runtime.container}`, `--label=${STACK_LABEL}`, "--label=ai.saycode.abp.role=runtime", `--label=ai.saycode.abp.image=${imageRef(image)}`,
    `--network=${layout.runtime.networks[0]}`, `--network-alias=${layout.runtime.alias}`,
    // S2 production start: root with only SETUID/SETGID to read the root-only config and bind the sockets, then drop.
    "--user=0:0", "--cap-drop=ALL", "--cap-add=SETUID", "--cap-add=SETGID", "--security-opt=no-new-privileges",
    "--read-only", "--tmpfs=/tmp:rw,size=64m", "--pids-limit=256", "--memory=1g", "--cpus=1", "--restart=no", ...logOpts,
    `--mount=type=volume,source=${layout.runtime.volume},target=${IN_CONTAINER.state}`,
    `--mount=type=bind,source=${PATHS.run},target=${PATHS.run}`,
    `--mount=type=bind,source=${PATHS.runtimeConfig},target=${PATHS.runtimeConfig},readonly`,
    `--mount=type=bind,source=${PATHS.runtimeSecrets},target=${IN_CONTAINER.secrets},readonly`,
    `--env=ABP_STATE_DIR=${IN_CONTAINER.stateDir}`,
    `--env=ABP_CONFIG_FILE=${PATHS.runtimeConfig}`,
    `--env=ABP_VNC_PASSWORD_FILE=${IN_CONTAINER.vncPassword}`,
    `--env=ABP_PROFILES=${JSON.stringify(endpoints)}`,
    `--publish=127.0.0.1:${layout.runtimePort}:${layout.runtimePort}`,
    image,
  ];
}

export function browserCreateArgs(layout, browser, image) {
  const uid = IDS.browserUid;
  const tmpfs = (path, size) => `--tmpfs=${path}:rw,uid=${uid},gid=${uid},size=${size}`;
  return [
    "create", `--name=${browser.container}`, `--label=${STACK_LABEL}`, "--label=ai.saycode.abp.role=browser", `--label=ai.saycode.abp.profile=${browser.profileId}`, `--label=ai.saycode.abp.image=${imageRef(image)}`,
    `--network=${browser.network}`, `--network-alias=${browser.alias}`,
    `--user=${uid}:${uid}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", `--security-opt=seccomp=${PATHS.seccompProfile}`,
    "--read-only", "--tmpfs=/tmp:rw,size=128m", tmpfs("/run/abp", "1m"), tmpfs("/home/browser/.cache", "64m"), tmpfs("/home/browser/.config", "64m"), tmpfs("/home/browser/.local", "64m"),
    "--pids-limit=512", "--memory=2g", "--cpus=2", "--shm-size=256m", "--restart=no", ...logOpts,
    `--mount=type=volume,source=${browser.volume},target=${IN_CONTAINER.profile}`,
    `--mount=type=bind,source=${PATHS.browserSecrets},target=${IN_CONTAINER.secrets},readonly`,
    `--env=ABP_CDP_HOST=${browser.alias}:9223`,
    image,
  ];
}
