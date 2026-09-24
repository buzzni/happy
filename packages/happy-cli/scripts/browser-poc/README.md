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

Fixture sites share container port 8080: `http://a.poc-one.test:8080`, `http://b.poc-two.test:8080`, `http://c.poc-three.test:8080`. Browser profiles use network DNS mapping to the fixture. The control API listens on 9099 inside the fixture and requires `x-harness-token` on every request. Browser CDP at browser-a/browser-b port 9223 and instance service at 9224 are internal only. noVNC is exposed on dynamic loopback ports listed in env.json.

Smoke checks (replace names and ports from env.json):

```sh
docker exec abp-smoke-1-browser-a curl -fsS http://a.poc-one.test:8080/marker?label=smoke
docker run --rm --network abp-smoke-1 curlimages/curl:latest curl -fsS http://browser-a:9223/json/version
docker run --rm --network abp-smoke-1 curlimages/curl:latest curl -fsS http://browser-a:9224/instance
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
