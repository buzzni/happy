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

Suite-specific fixture routes (`// ---- a05a06a08a09a11 routes ----` block, site A only): `/x5/panel?label=&color=&key=` (coloured panel with a `Press <label>` button and an optional barrier-driven `GATE OPEN` text), `/x5/controls?n=` (disabled + hidden buttons and `n` items inside a form, for truncation/subtree observation), `/x5/frame-reattach?key=` (site B iframe replaced by a fresh one when the barrier is released), `/x5/risky-mutating?key=&mode=reload|origin|value|node` (risky payment form whose document/origin/field value/button node changes when the barrier is released). All clicks are recorded as ledger `click` entries with the target label.
