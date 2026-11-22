#!/bin/bash
# Runs the work machine migration rehearsal in a disposable Linux container.
#
# Work machine execution is Linux-only. This copies the checkout (without node_modules,
# dist or .git) into a named volume, installs Linux dependencies there, and runs the
# opt-in rehearsal test. Everything stays on loopback inside the container: a local
# standalone Happy server (PGlite), two daemon homes and a fake model endpoint. No
# credential or endpoint from the host is passed in.
#
# Usage: scripts/work-machine-rehearsal-linux.sh [extra vitest args]
set -euo pipefail
cli_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_dir=$(cd "$cli_dir/../.." && pwd)
image=happy-work-machine-rehearsal
volume=${HAPPY_REHEARSAL_VOLUME:-happy-work-machine-rehearsal}

docker build -q -t "$image" -f "$cli_dir/scripts/work-machine-rehearsal.Dockerfile" "$cli_dir/scripts" >/dev/null
docker run --rm --init -v "$repo_dir:/src:ro" -v "$volume:/work" \
    -e HAPPY_WORK_MACHINE_REHEARSAL=1 -e HAPPY_REHEARSAL_ROOT=/work/runs -e HAPPY_REHEARSAL_CODEX="${HAPPY_REHEARSAL_CODEX:-1}" \
    "$image" bash -euo pipefail -c '
mkdir -p /work/repo
# Failed runs are kept under /work/runs for inspection; each invocation starts clean.
rm -rf /work/runs
tar -C /src --exclude=node_modules --exclude=./packages/*/dist --exclude=.git -cf - . | tar -C /work/repo -xf -
cd /work/repo
filters=(--filter "@buzzni/happy-cli..." --filter "happy-server-self-host...")
if [ ! -f node_modules/.rehearsal-lock ] || ! cmp -s pnpm-lock.yaml node_modules/.rehearsal-lock; then
    pnpm install --frozen-lockfile --ignore-scripts "${filters[@]}"
    node patches/fix-pglite-prisma-bytes.cjs
    (cd packages/happy-cli && node scripts/unpack-tools.cjs && pnpm rebuild node-pty >/dev/null)
    cp pnpm-lock.yaml node_modules/.rehearsal-lock
fi
# The schema changes without the lockfile; a cached client would miss new columns.
(cd packages/happy-server && npx prisma generate --schema=prisma/schema.prisma >/dev/null)
pnpm --filter @slopus/happy-wire build >/dev/null
cd packages/happy-cli
exec npx vitest run --project integration-work-machine-rehearsal "$@"
' rehearsal "$@"
