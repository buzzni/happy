#!/usr/bin/env node
// abp-stack — operate the Agent Browser stack on execution machine H (spec D11).
// Installed by abp-install as /usr/local/sbin/abp-stack (root only).
//
//   abp-stack up | down | status [--json]
//   abp-stack upgrade (--images <dir> | --runtime-image <sha256:…> --browser-image <sha256:…>) [--ready-timeout <s>]
//   abp-stack rollback [--ready-timeout <s>]
//   abp-stack rotate-keys [--daemon-token] [--vnc-password]      (both when neither is given)
//   abp-stack set-principal <profileId> <principalId>
//   abp-stack load <dir> [--set-initial]                          (docker load + digest check)
//   abp-stack build --source <happy-cli dir> [--out <dir>] [--tag <tag>] [--set-initial]
//   abp-stack run                                                 (abp-stack.service only)
//
// Containers, networks and volumes carry the label ai.saycode.abp=stack. Images
// are referenced only by content digest (sha256:…); /var/lib/abp/stack-state.json
// records the current and previous digests. Volumes (abp-state, abp-profile-*)
// are never removed here; see abp-uninstall --purge.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fchownSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PATHS, STACK_LABEL, browserCreateArgs, mergeInstallOptions, runtimeConfig, runtimeCreateArgs, stackLayout } from "./lib/abpPlan.mjs";

const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const IMAGE_LABEL = '{{index .Config.Labels "ai.saycode.abp.image"}}';
const RESTART_BACKOFF_MS = { first: 2_000, max: 60_000, resetAfterRunningMs: 60_000 };
const DEFAULT_READY_TIMEOUT_MS = 180_000;
const SERVICE = "abp-stack.service";
const DAEMON_SERVICE = "abp-happy-daemon.service";
const SECRET_FILES = {
  runtimeVnc: { path: `${PATHS.runtimeSecrets}/vnc-password`, mode: 0o440, owner: "abp-runtime", group: "root" },
  browserVnc: { path: `${PATHS.browserSecrets}/vnc-password`, mode: 0o400, owner: "abp-browser", group: "abp-browser" },
  daemonToken: { path: PATHS.daemonToken, mode: 0o400, owner: "agent", group: "agent" },
};

/** Real host: docker/systemctl through spawnSync, atomic root-owned writes, loopback readiness. */
export function systemDeps() {
  const lookup = (args) => {
    const result = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
    const value = Number(String(result.stdout).trim().split(":")[2] ?? String(result.stdout).trim());
    if (result.status !== 0 || !Number.isInteger(value)) throw new Error(`unknown account ${args.at(-1)}`);
    return value;
  };
  const uidOf = (name) => (name === "root" ? 0 : lookup(["id", "-u", name]));
  const gidOf = (name) => (name === "root" ? 0 : lookup(["getent", "group", name]));
  return {
    run(cmd, args, { allowFail = false, input } = {}) {
      const result = spawnSync(cmd, args, { encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
      if (result.error) throw new Error(`${cmd} could not run: ${result.error.code ?? result.error.message}`);
      const out = { status: result.status ?? 1, stdout: String(result.stdout).trim(), stderr: String(result.stderr).trim() };
      // Our docker arguments carry no secret (passwords and tokens are files), so stderr can be shown.
      if (out.status !== 0 && !allowFail) throw new Error(`${cmd} ${args[0]} failed (status ${out.status}): ${out.stderr.split("\n").slice(-3).join(" ")}`);
      return out;
    },
    readFile: (path) => readFileSync(path, "utf8"),
    exists: (path) => existsSync(path),
    writeFileAtomic(path, data, { mode, owner, group }) {
      const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}`);
      const fd = openSync(tmp, "wx", mode);
      try {
        writeSync(fd, data);
        fchownSync(fd, uidOf(owner), gidOf(group));
        fsyncSync(fd);
      } catch (error) {
        closeSync(fd);
        rmSync(tmp, { force: true });
        throw error;
      }
      closeSync(fd);
      renameSync(tmp, path);
      const dir = openSync(dirname(path), "r");
      try { fsyncSync(dir); } finally { closeSync(dir); }
    },
    groupId: gidOf,
    async ready(port) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/v1/ready`, { signal: AbortSignal.timeout(3_000) });
        return { status: response.status, body: await response.json().catch(() => undefined) };
      } catch {
        return { status: 0 };
      }
    },
    sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    now: () => Date.now(),
    log: (line) => process.stderr.write(`[abp-stack] ${new Date().toISOString()} ${line}\n`),
    secret: (kind) => (kind === "vnc-password" ? randomBytes(6).toString("base64url") : randomBytes(32).toString("hex")),
    tempDir: () => mkdtempSync(join(tmpdir(), "abp-build-")),
    copyFile: (from, to) => copyFileSync(from, to),
    mkdir: (path) => mkdirSync(path, { recursive: true, mode: 0o755 }),
    remove: (path) => rmSync(path, { recursive: true, force: true }),
  };
}

export function createStack(deps) {
  const docker = (args, opts) => deps.run("docker", args, opts);
  const systemctl = (args, opts) => deps.run("systemctl", args, opts);
  const readJson = (path) => JSON.parse(deps.readFile(path));
  const install = () => readJson(PATHS.installConfig);
  const layout = () => stackLayout(install());
  const readState = () => (deps.exists(PATHS.stackState) ? readJson(PATHS.stackState) : { schemaVersion: 1, current: null, previous: null, history: [] });
  const writeState = (state) => deps.writeFileAtomic(PATHS.stackState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
  const record = (state, entry) => ({ ...state, history: [...state.history, { atMs: deps.now(), ...entry }].slice(-50) });

  function assertImages(ids) {
    for (const role of ["runtime", "browser"]) {
      if (!IMAGE_ID.test(ids?.[role] ?? "")) throw new Error(`${role} image must be a content digest (sha256:<64 hex>)`);
      const found = docker(["image", "inspect", "--format", "{{.Id}}", ids[role]], { allowFail: true });
      if (found.status !== 0) throw new Error(`${role} image ${ids[role]} is not loaded`);
      if (found.stdout !== ids[role]) throw new Error(`${role} image digest mismatch`);
    }
  }

  /** Regenerates runtime.json from install.json, keeping the resolved machine id and (unless given) the token hash. */
  function writeRuntimeConfig(options, daemonTokenSha256) {
    const existing = deps.exists(PATHS.runtimeConfig) ? readJson(PATHS.runtimeConfig) : {};
    const machineId = options.machineId !== "auto" ? options.machineId : existing.machineId;
    if (!machineId) throw new Error("machineId is unresolved; run abp-install after the agent's Happy login");
    const config = runtimeConfig({ ...options, machineId }, { sessionGid: deps.groupId("abp-session"), daemonTokenSha256: daemonTokenSha256 ?? existing.daemonTokenSha256 });
    deps.writeFileAtomic(PATHS.runtimeConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
  }

  const restartRuntime = () => docker(["restart", "-t", "30", layout().runtime.container], { allowFail: true });

  async function waitReady(runtimeImage, timeoutMs) {
    const deadline = deps.now() + timeoutMs;
    const { runtimePort, runtime } = layout();
    let last;
    while (deps.now() < deadline) {
      // The Runtime answering must be the one started from the expected digest.
      const label = docker(["inspect", "-f", IMAGE_LABEL, runtime.container], { allowFail: true });
      if (label.status === 0 && label.stdout === runtimeImage) {
        last = await deps.ready(runtimePort);
        if (last.status === 200) return { ok: true, body: last.body };
      }
      await deps.sleep(1_000);
    }
    return { ok: false, body: last?.body };
  }

  /** Stops the stack (Runtime first: its API closes, running tasks recover paused), switches digests, starts, waits for /v1/ready. */
  async function switchTo(target, action, readyTimeoutMs) {
    const before = readState();
    systemctl(["stop", SERVICE]);
    writeState({ ...before, current: target, previous: before.current });
    systemctl(["start", SERVICE]);
    const ready = await waitReady(target.runtime, readyTimeoutMs);
    writeState(record(readState(), { action, from: before.current, to: target, result: ready.ok ? "ready" : "not-ready", ready: ready.body }));
    return { ready, before };
  }

  const stack = {
    /** Recreates the stack containers from the current digests (volumes and networks kept) and starts them. */
    async start() {
      const state = readState();
      if (!state.current) throw new Error("no images installed (abp-install --images/--build-from, or abp-stack load --set-initial)");
      const plan = layout();
      for (const network of plan.networks) {
        if (docker(["network", "inspect", network], { allowFail: true }).status !== 0) docker(["network", "create", "--driver=bridge", `--label=${STACK_LABEL}`, network]);
      }
      for (const volume of plan.volumes) {
        if (docker(["volume", "inspect", volume], { allowFail: true }).status !== 0) docker(["volume", "create", `--label=${STACK_LABEL}`, volume]);
      }
      const old = docker(["ps", "-aq", "--filter", `label=${STACK_LABEL}`]).stdout.split("\n").filter(Boolean);
      if (old.length) docker(["rm", "-f", ...old]);
      for (const browser of plan.browsers) {
        docker(browserCreateArgs(plan, browser, state.current.browser));
        docker(["start", browser.container]);
      }
      docker(runtimeCreateArgs(plan, state.current.runtime));
      for (const network of plan.runtime.networks.slice(1)) docker(["network", "connect", `--alias=${plan.runtime.alias}`, network, plan.runtime.container]);
      docker(["start", plan.runtime.container]);
      deps.log(`started runtime=${state.current.runtime} browser=${state.current.browser} profiles=${plan.browsers.length}`);
    },

    /** One supervision pass: restarts exited containers with exponential backoff (exit 75 = writer lock held). */
    superviseOnce(backoff) {
      const plan = layout();
      for (const name of [...plan.browsers.map((browser) => browser.container), plan.runtime.container]) {
        const entry = backoff.get(name) ?? { delayMs: 0, nextAtMs: 0, runningSinceMs: undefined };
        const [running, status] = docker(["inspect", "-f", "{{.State.Running}} {{.State.ExitCode}}", name], { allowFail: true }).stdout.split(" ");
        if (running === "true") {
          entry.runningSinceMs ??= deps.now();
          if (deps.now() - entry.runningSinceMs >= RESTART_BACKOFF_MS.resetAfterRunningMs) entry.delayMs = 0;
        } else {
          entry.runningSinceMs = undefined;
          if (deps.now() >= entry.nextAtMs) {
            deps.log(`${name} exited status=${status ?? "missing"}; starting (backoff ${entry.delayMs} ms)`);
            docker(["start", name], { allowFail: true });
            entry.delayMs = Math.min(entry.delayMs ? entry.delayMs * 2 : RESTART_BACKOFF_MS.first, RESTART_BACKOFF_MS.max);
            entry.nextAtMs = deps.now() + entry.delayMs;
          }
        }
        backoff.set(name, entry);
      }
    },

    /** Runtime first (closes its API; running tasks recover paused on the next start), then the browsers. */
    stop() {
      const plan = layout();
      docker(["stop", "-t", "30", plan.runtime.container], { allowFail: true });
      for (const browser of plan.browsers) docker(["stop", "-t", "10", browser.container], { allowFail: true });
    },

    load(dir) {
      const manifest = readJson(join(dir, "manifest.json"));
      docker(["load", "-i", join(dir, "images.tar")]);
      const ids = { runtime: manifest.runtime?.id, browser: manifest.browser?.id };
      assertImages(ids);
      return ids;
    },

    /** First install only: an existing current digest is changed by upgrade, never here. */
    setInitialImages(ids) {
      assertImages(ids);
      const state = readState();
      if (state.current && (state.current.runtime !== ids.runtime || state.current.browser !== ids.browser)) {
        deps.log("images already installed; use abp-stack upgrade to switch digests");
        return state.current;
      }
      if (!state.current) writeState(record({ ...state, current: ids }, { action: "install", to: ids, result: "recorded" }));
      return ids;
    },

    async upgrade({ images, ids, readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS }) {
      const target = images ? stack.load(images) : ids;
      assertImages(target);
      const state = readState();
      if (!state.current) throw new Error("no current images; install first");
      if (state.current.runtime === target.runtime && state.current.browser === target.browser) return { changed: false };
      const { ready, before } = await switchTo(target, "upgrade", readyTimeoutMs);
      if (ready.ok) return { changed: true, ready: ready.body };
      deps.log("upgrade: new Runtime not ready; rolling back to the previous digests (volumes kept)");
      systemctl(["stop", SERVICE]);
      writeState({ ...readState(), current: before.current, previous: before.previous });
      systemctl(["start", SERVICE]);
      const back = await waitReady(before.current.runtime, readyTimeoutMs);
      writeState(record(readState(), { action: "auto-rollback", from: target, to: before.current, result: back.ok ? "ready" : "not-ready", ready: back.body }));
      throw new Error(back.ok ? "upgrade failed: Runtime not ready; rolled back to the previous digests"
        : "upgrade failed and the rolled back Runtime is not ready either; see abp-stack status and journalctl -u abp-stack");
    },

    async rollback({ readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS } = {}) {
      const state = readState();
      if (!state.previous) throw new Error("no previous digests recorded");
      assertImages(state.previous);
      const { ready } = await switchTo(state.previous, "rollback", readyTimeoutMs);
      if (!ready.ok) throw new Error("rollback: Runtime not ready (a journal from a newer schema is refused on purpose); see abp-stack status");
      return { ready: ready.body };
    },

    /**
     * Daemon token: new file for agent, its hash into runtime.json, Runtime restarted (sessions keep their
     * registered secrets; running tasks recover paused), then the daemon (sessions stay alive).
     * VNC password: both copies rewritten, x11vnc restarted inside each browser (Chromium keeps running), Runtime restarted.
     * Rerun after an interruption: each step rewrites from a fresh secret.
     */
    async rotateKeys({ daemonToken = true, vncPassword = true } = {}) {
      if (daemonToken) {
        const token = deps.secret("daemon-token");
        writeRuntimeConfig(install(), createHash("sha256").update(token).digest("hex"));
        deps.writeFileAtomic(SECRET_FILES.daemonToken.path, token, SECRET_FILES.daemonToken);
      }
      if (vncPassword) {
        const password = deps.secret("vnc-password");
        deps.writeFileAtomic(SECRET_FILES.runtimeVnc.path, password, SECRET_FILES.runtimeVnc);
        deps.writeFileAtomic(SECRET_FILES.browserVnc.path, password, SECRET_FILES.browserVnc);
        for (const browser of layout().browsers) docker(["exec", browser.container, "pkill", "-x", "x11vnc"], { allowFail: true });
      }
      if (daemonToken || vncPassword) restartRuntime();
      if (daemonToken) systemctl(["restart", DAEMON_SERVICE], { allowFail: true });
      deps.log(`rotated${daemonToken ? " daemon-token" : ""}${vncPassword ? " vnc-password" : ""}`);
      writeState(record(readState(), { action: "rotate-keys", result: [daemonToken && "daemon-token", vncPassword && "vnc-password"].filter(Boolean).join(",") }));
    },

    setPrincipal(profileId, principalId) {
      const options = install();
      if (!options.profiles.some((profile) => profile.profileId === profileId)) throw new Error(`unknown profile ${profileId}`);
      const merged = mergeInstallOptions(options, { profiles: options.profiles.map((profile) => (profile.profileId === profileId ? { profileId, principalId } : profile)) });
      deps.writeFileAtomic(PATHS.installConfig, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600, owner: "root", group: "root" });
      writeRuntimeConfig(merged);
      restartRuntime();
    },

    async status() {
      const plan = layout();
      const state = readState();
      const checks = [];
      const check = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
      check("service", systemctl(["is-active", SERVICE], { allowFail: true }).stdout === "active");
      const containers = [[plan.runtime.container, state.current?.runtime], ...plan.browsers.map((browser) => [browser.container, state.current?.browser])];
      for (const [name, image] of containers) {
        const [running, label] = docker(["inspect", "-f", `{{.State.Running}} ${IMAGE_LABEL}`, name], { allowFail: true }).stdout.split(" ");
        check(`container ${name}`, running === "true" && label === image, `running=${running ?? "missing"} image=${label === image ? "pinned" : label ?? "?"}`);
      }
      const published = docker(["ps", "--filter", `label=${STACK_LABEL}`, "--format", "{{.Names}}\t{{.Ports}}"], { allowFail: true }).stdout
        .split("\n").filter(Boolean).flatMap((line) => {
          const [name, ports = ""] = line.split("\t");
          return ports.split(",").map((port) => port.trim()).filter((port) => port.includes("->")).map((port) => `${name} ${port}`);
        });
      const expected = `${plan.runtime.container} 127.0.0.1:${plan.runtimePort}->${plan.runtimePort}/tcp`;
      check("published ports", published.length === 1 && published[0] === expected, published.join("; ") || "none");
      const ready = await deps.ready(plan.runtimePort);
      check("runtime ready", ready.status === 200, JSON.stringify(ready.body ?? {}));
      // A sandboxed renderer/zygote lives in a nested PID namespace (NSpid has two ids); no process may carry --no-sandbox.
      const probe = "s=0; for p in $(pgrep -f -- '--type=([r]enderer|[z]ygote)'); do set -- $(grep '^NSpid:' /proc/$p/status 2>/dev/null); [ $# -ge 3 ] && s=$((s+1)); done; echo \"sandboxed $s\"; echo \"nosandbox $(pgrep -fc -- '--no-[s]andbox' || true)\"";
      for (const browser of plan.browsers) {
        const out = docker(["exec", browser.container, "sh", "-c", probe], { allowFail: true }).stdout;
        const value = (key) => Number(out.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1] ?? NaN);
        check(`chromium sandbox ${browser.container}`, value("sandboxed") > 0 && value("nosandbox") === 0, out.replace(/\n/g, " "));
      }
      return { ok: checks.every((entry) => entry.ok), images: state.current, previous: state.previous, checks };
    },

    /** Builds both images in a minimal context (no node_modules) and optionally saves them with a digest manifest. */
    build({ source, out, tag = `local-${deps.now()}` }) {
      const packageDir = resolve(source);
      const staging = deps.tempDir();
      try {
        deps.run(process.execPath, [join(packageDir, "scripts/browser-poc/build-runtime.mjs"), join(staging, "runtime.mjs")]);
        const poc = join(packageDir, "scripts/browser-poc/images");
        const own = join(packageDir, "scripts/agent-browser/images");
        for (const [from, name] of [[join(poc, "runtime-entrypoint.sh"), "runtime-entrypoint.sh"], [join(poc, "cdp-proxy.py"), "cdp-proxy.py"], [join(poc, "instance-server.py"), "instance-server.py"],
          [join(own, "runtime.Dockerfile"), "runtime.Dockerfile"], [join(own, "browser.Dockerfile"), "browser.Dockerfile"], [join(own, "browser-entrypoint.sh"), "browser-entrypoint.sh"]]) {
          deps.copyFile(from, join(staging, name));
        }
        const ids = {};
        for (const role of ["runtime", "browser"]) {
          docker(["build", "--pull=false", "-f", join(staging, `${role}.Dockerfile`), "-t", `abp-${role}:${tag}`, staging]);
          ids[role] = docker(["image", "inspect", "--format", "{{.Id}}", `abp-${role}:${tag}`]).stdout;
        }
        assertImages(ids);
        if (out) {
          deps.mkdir(out);
          docker(["save", "-o", join(out, "images.tar"), `abp-runtime:${tag}`, `abp-browser:${tag}`]);
          const manifest = { schemaVersion: 1, tag, builtAtMs: deps.now(), runtime: { id: ids.runtime, tag: `abp-runtime:${tag}` }, browser: { id: ids.browser, tag: `abp-browser:${tag}` } };
          deps.writeFileAtomic(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644, owner: "root", group: "root" });
        }
        return ids;
      } finally {
        deps.remove(staging);
      }
    },
  };
  return stack;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

/** abp-stack.service: start, then supervise until SIGTERM, then stop (Runtime first). */
async function runForeground(deps, stack) {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    deps.log("stopping (Runtime first)");
    stack.stop();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  await stack.start();
  const backoff = new Map();
  for (;;) {
    await deps.sleep(2_000);
    if (!stopping) stack.superviseOnce(backoff);
  }
}

export async function main(argv, deps = systemDeps()) {
  if (process.getuid?.() !== 0) throw new Error("run as root");
  const [command, ...args] = argv;
  const stack = createStack(deps);
  const timeout = option(args, "--ready-timeout") ? Number(option(args, "--ready-timeout")) * 1_000 : undefined;
  switch (command) {
    case "run": return runForeground(deps, stack);
    case "up": {
      deps.run("systemctl", ["start", SERVICE]);
      const ready = await waitForReady(deps, timeout);
      console.log(ready ? "ready" : "started, not ready yet (abp-stack status)");
      process.exitCode = ready ? 0 : 1;
      return;
    }
    case "down": deps.run("systemctl", ["stop", SERVICE]); return;
    case "status": {
      const report = await stack.status();
      if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
      else for (const check of report.checks) console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}${check.detail ? `  ${check.detail}` : ""}`);
      process.exitCode = report.ok ? 0 : 1;
      return;
    }
    case "load": {
      const ids = stack.load(args[0]);
      if (args.includes("--set-initial")) stack.setInitialImages(ids);
      console.log(JSON.stringify(ids));
      return;
    }
    case "build": {
      const ids = stack.build({ source: option(args, "--source") ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."), out: option(args, "--out"), tag: option(args, "--tag") });
      if (args.includes("--set-initial")) stack.setInitialImages(ids);
      console.log(JSON.stringify(ids));
      return;
    }
    case "upgrade": {
      const images = option(args, "--images");
      const ids = images ? undefined : { runtime: option(args, "--runtime-image"), browser: option(args, "--browser-image") };
      console.log(JSON.stringify(await stack.upgrade({ images, ids, readyTimeoutMs: timeout })));
      return;
    }
    case "rollback": console.log(JSON.stringify(await stack.rollback({ readyTimeoutMs: timeout }))); return;
    case "rotate-keys": {
      const some = args.includes("--daemon-token") || args.includes("--vnc-password");
      await stack.rotateKeys({ daemonToken: !some || args.includes("--daemon-token"), vncPassword: !some || args.includes("--vnc-password") });
      return;
    }
    case "set-principal":
      if (!args[0] || !args[1]) throw new Error("usage: abp-stack set-principal <profileId> <principalId>");
      stack.setPrincipal(args[0], args[1]);
      return;
    default:
      throw new Error("usage: abp-stack up|down|status|upgrade|rollback|rotate-keys|set-principal|load|build|run");
  }
}

async function waitForReady(deps, timeoutMs = DEFAULT_READY_TIMEOUT_MS) {
  const { runtimePort } = JSON.parse(deps.readFile(PATHS.installConfig));
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if ((await deps.ready(runtimePort)).status === 200) return true;
    await deps.sleep(1_000);
  }
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`abp-stack: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exit(1);
  });
}

