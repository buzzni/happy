#!/bin/sh
set -eu
[ -f /.dockerenv ] && [ "${HAPPY_SANDBOX_LINUX_SMOKE:-}" = 1 ] && [ "$(id -u)" != 0 ] || exit 125
exec node --import /test/node_modules/tsx/dist/loader.mjs scripts/sandbox-linux-smoke.ts
