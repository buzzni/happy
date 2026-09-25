# Agent Browser PoC harness

Run from `packages/happy-cli`. Requires Docker and Node 20+. Every Docker resource is labelled `ai.saycode.abp-run=<run>`; use a unique lowercase run ID. All published ports bind to 127.0.0.1. The harness token and ports are written to `scripts/browser-poc/.abp/<run>/env.json` (mode 0600, gitignored). Keep this file private.

```sh
node scripts/browser-poc/poc.mjs up --run smoke-1 --runtime-bundle /absolute/path/runtime.mjs --runtime-env /absolute/path/runtime-env.json
node scripts/browser-poc/poc.mjs health --run smoke-1
node scripts/browser-poc/poc.mjs ps --run smoke-1
node scripts/browser-poc/poc.mjs ledger --run smoke-1
node scripts/browser-poc/poc.mjs release-barrier --run smoke-1 --key gate --nonce synthetic-nonce
node scripts/browser-poc/poc.mjs fault kill-chrome --run smoke-1 --profile a
node scripts/browser-poc/poc.mjs fault restart-browser-container --run smoke-1 --profile a
node scripts/browser-poc/poc.mjs fault restart-runtime --run smoke-1
node scripts/browser-poc/poc.mjs fault kill-runtime --run smoke-1
node scripts/browser-poc/poc.mjs fault pause-runtime --run smoke-1
node scripts/browser-poc/poc.mjs fault unpause-runtime --run smoke-1
node scripts/browser-poc/poc.mjs down --run smoke-1
node scripts/browser-poc/poc.mjs down --run smoke-1 --purge
```

`up` can omit `--runtime-bundle` when testing fixture and browsers alone. `--runtime-env` is a JSON object of environment variables. The Runtime bundle must be readable by uid 1000 inside the container (for example, mode 0644). `--rebuild` forces image rebuild. `down` keeps profile and state volumes by default; `--purge` deletes volumes labelled with this run. `fill-disk` is not implemented.

Fixture sites share container port 8080: `http://a.poc-one.test:8080`, `http://b.poc-two.test:8080`, `http://c.poc-three.test:8080`. Browser profiles use network DNS mapping to the fixture. The control API listens on 9099 inside the fixture and requires `x-harness-token` on every request. Browser CDP at browser-a/browser-b port 9223 and instance service at 9224 are internal only: each browser sits on its own network (`abp-<run>-a` / `-b`) shared only with the Runtime and the fixture, and the CDP proxy accepts only `Host: browser-<profile>:9223`. The noVNC viewer requires the per-run password stored in `.abp/<run>/env.json` (`vncPassword`). noVNC is exposed on dynamic loopback ports listed in env.json.

Suite-specific fixture routes: `GET /a10/slow-write?run=&key=&ms=` (site A, A10 suite) ledgers `{kind: "slow-write", key}` on receipt and responds after `ms` (max 30 s), so a navigation write can be in flight across a Runtime crash.

Smoke checks (replace names and ports from env.json):

```sh
docker exec abp-smoke-1-browser-a curl -fsS http://a.poc-one.test:8080/marker?label=smoke
docker run --rm --network abp-smoke-1-a curlimages/curl:latest curl -fsS -H 'Host: browser-a:9223' http://browser-a:9223/json/version
docker run --rm --network abp-smoke-1-a curlimages/curl:latest curl -fsS http://browser-a:9224/instance
```

## A12 resources, soak, rollback

Use a unique image tag for every run. The A12 cycle suite defaults to three repetitions of 100 task/page/action/finish/close cycles; `ABP_REPEAT` and `ABP_CYCLES` shorten local diagnosis only.

```sh
ABP_IMAGE_TAG=e2ed pnpm exec vitest run --project browser-poc src/browserRuntime/e2e/a12Resources.poc.test.ts
ABP_IMAGE_TAG=e2ed pnpm exec vitest run --project browser-poc src/browserRuntime/e2e/a12Rollback.poc.test.ts
ABP_IMAGE_TAG=e2ed pnpm exec vitest run --project browser-poc src/browserRuntime/e2e/a12Soak.poc.test.ts
ABP_IMAGE_TAG=e2ed node scripts/browser-poc/soak.mjs --run <running-run> --minutes 30
ABP_IMAGE_TAG=e2ed node scripts/browser-poc/rollback.mjs --run <running-run>
```

`soak.mjs` requires a running harness stack and reads its private `.abp/<run>/env.json` and `keys.json`. It warms up for five minutes, samples once a minute, writes `soak.jsonl` and `soak-summary.json`, and compares the first and last five measured minutes. `rollback.mjs` fences active tasks through the public cancel API, stops only that run's Runtime, restarts a run-owned browser to verify its profile volume canary and noVNC viewer, and removes only that run's containers and network. It preserves the synthetic profile volumes for inspection. To restore legacy agent tools, unset `HAPPY_BROWSER_TASK_RUNTIME_URL` before starting the agent; `src/claude/utils/startHappyServer.test.ts` verifies legacy `browser_*` tools appear without the flag. The PoC routing image is isolated to the labelled run, so removing that run restores the prior route. Synthetic volumes may later be purged with `node scripts/browser-poc/poc.mjs down --run <run> --purge` after inspection.

- `a02a04` suites (A02/A04 E2E) add per-tag routes under `/login-strict|protected-strict|challenge-strict|captcha-protected|a02a04-after|a02a04-tick/<tag>` (strict password `correct-horse`, ledger kinds `a02a04-*`).
Suite-specific fixture routes (`// ---- a05a06a08a09a11 routes ----` block, site A only): `/x5/panel?label=&color=&key=` (coloured panel with a `Press <label>` button and an optional barrier-driven `GATE OPEN` text), `/x5/controls?n=` (disabled + hidden buttons and `n` items inside a form, for truncation/subtree observation), `/x5/frame-reattach?key=` (site B iframe replaced by a fresh one when the barrier is released), `/x5/risky-mutating?key=&mode=reload|origin|value|node` (risky payment form whose document/origin/field value/button node changes when the barrier is released; shows `PAYMENT SENT` once the write is acknowledged), `/x5/spa?key=&mode=swap|hover` (button replaced by a decoy when the barrier is released, or on the first pointer move after it). All clicks are recorded as ledger `click` entries with the target label.

## Real-agent runs (A01 / A08 / sandbox)

These need (1) an isolated Happy daemon running this branch — `node scripts/install-isolated.cjs`, then copy an authenticated `access.key` into its home and `happy daemon start` with `HAPPY_HOME_DIR` set (see the script's printed commands; remove the key copy afterwards), and (2) a Desktop checkout with `desktop-session-client.ts.txt` copied to `.abp-harness/sessionClient.ts` (set `ABP_SESSION_CLIENT_DIR` to that checkout). Then:

```sh
pnpm exec tsx src/browserRuntime/e2e/stackCli.ts up <run>
pnpm exec tsx src/browserRuntime/e2e/realAgentA01.ts --run <run> --iteration 1
pnpm exec tsx src/browserRuntime/e2e/realAgentA08.ts --run <run> --iteration 1
pnpm exec tsx src/browserRuntime/e2e/realAgentSandbox.ts --run <run>
node scripts/browser-poc/poc.mjs down --run <run> --purge
```

Note: the server can push a happy-cli update to every registered machine, which restarts the isolated daemon on the globally installed CLI (the `browser_task_*` tools disappear). Check `daemon.state.json` → `startedWithCliVersion` before a run.
