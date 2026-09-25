#!/bin/sh
# Browser Runtime container entrypoint (D9 writer lock).
# Takes an exclusive kernel flock on runtime.flock in the state volume — a file
# that is never replaced — before node opens the TaskStore or any CDP
# connection. -n: a second Runtime on the same state volume exits at once
# (status 75, the restart policy backs off). -F: no fork, so node itself holds
# the lock for its whole life and the kernel drops it when node dies.
set -eu
state_dir="${ABP_STATE_DIR:-/var/lib/abp/state}"
mkdir -p "$state_dir"
ABP_WRITER_FLOCK="$state_dir/runtime.flock"
export ABP_WRITER_FLOCK
exec flock -n -E 75 -F "$ABP_WRITER_FLOCK" node /app/runtime.mjs
