#!/bin/bash
set -euo pipefail
[[ -f /.dockerenv && ${HAPPY_SANDBOX_LINUX_SMOKE:-} == 1 && $(id -u) == 0 ]] || exit 125
install -o root -g root -m 0755 scripts/agent-browser/claude-sbx-launch /usr/local/libexec/abp/claude-sbx-launch
gcc -Wall -Wextra -Werror scripts/agent-browser/abp-firewall-read.c -o /usr/local/libexec/abp/abp-firewall-read
chown root:abp-session /usr/local/libexec/abp/abp-firewall-read
chmod 4750 /usr/local/libexec/abp/abp-firewall-read
exec node --import /test/node_modules/tsx/dist/loader.mjs scripts/sandbox-linux-smoke.ts
