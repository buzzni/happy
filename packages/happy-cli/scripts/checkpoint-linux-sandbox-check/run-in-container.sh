#!/usr/bin/env bash
# specs/linux-checkpoint-enforcement-backend — runs the Linux checkpoint sandbox integration test
# inside an Ubuntu 22.04 container with real bubblewrap. Usage (from the monorepo root):
#   docker build -t happy-linux-sandbox-check packages/happy-cli/scripts/checkpoint-linux-sandbox-check
#   docker run --rm --privileged -v "$PWD":/src:ro happy-linux-sandbox-check \
#     bash /src/packages/happy-cli/scripts/checkpoint-linux-sandbox-check/run-in-container.sh
# --privileged is needed for unprivileged user namespaces inside Docker; on a real Ubuntu host the
# daemon needs only bubblewrap, socat and ripgrep installed.
set -euo pipefail
mkdir -p /work && cd /work
(cd /src && tar --exclude=node_modules --exclude=.pnpm-store --exclude=.aplus --exclude=dist -cf - .) | tar -xf - -C /work
echo "== host =="; bwrap --version; uname -m; head -1 /etc/os-release
bwrap --ro-bind / / --unshare-user --unshare-pid true && echo "bwrap userns OK"
pnpm install --frozen-lockfile --filter @buzzni/happy-cli... >/dev/null
cd packages/happy-cli
echo "== srt checkDependencies =="
node -e "import('@anthropic-ai/sandbox-runtime').then((m) => console.log(JSON.stringify(m.SandboxManager.checkDependencies())))"
echo "== test =="
cat > /tmp/vitest.linux.config.ts <<'CFG'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
    test: {
        environment: 'node',
        include: ['src/checkpoint/checkpointSandbox.linux.integration.test.ts'],
        fileParallelism: false,
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
    resolve: { alias: { '@': resolve('./src') } },
})
CFG
cp /tmp/vitest.linux.config.ts ./vitest.linux.config.ts
npx vitest run --config vitest.linux.config.ts
