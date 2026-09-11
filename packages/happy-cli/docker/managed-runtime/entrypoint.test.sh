#!/bin/sh
# Drives the real entrypoint through every branch.
#
# `sleep` is a no-op on the PATH so the 120-iteration cap runs instantly — the
# script's own constant and its own branches are what execute, only the waiting
# is removed. A cap proven with a shortened constant would not be evidence about
# the constant that ships.
set -u
ENTRYPOINT=${1:?usage: entrypoint.test.sh <path-to-entrypoint>}
# Counted, because a suite that prints FAIL and exits 0 is a suite that reports
# a pass. Every branch runs first — one failure must not hide the others — and
# the total decides the exit status.
failures=0
T=$(mktemp -d)
# Removed however this exits — including the failure exit below and a TERM from
# whatever is driving the suite. A cleanup written as the last statement only
# runs when the last statement is reached.
trap 'rm -rf "$T"' EXIT INT TERM
mkdir -p "$T/bin"
# Accelerates only the entrypoint's own polling (`sleep 1`). A fixture that
# needs to stay alive uses a longer sleep and gets the real one — otherwise the
# stand-in supervisor would die instantly and every case would look like the
# supervisor-death branch.
cat > "$T/bin/sleep" <<'EOF'
#!/bin/sh
case "$1" in
  1) exit 0 ;;
  *) exec /bin/sleep "$@" ;;
esac
EOF
chmod +x "$T/bin/sleep"

run_case() {
    mode="$1"; expect_exit="$2"; expect_text="$3"
    cat > "$T/bin/node" <<EOF
#!/bin/sh
case "\$2" in
  managed-boot)
    case "$mode" in
      ready)  echo "managed runtime boot: supervisor listening (published)"; exec sleep 300 ;;
      byos)   exit 0 ;;
      refuse) echo "managed runtime boot refused: marker-untrusted" >&2; exit 1 ;;
      hang)   while : ; do : ; done ;;
      # Ignores TERM as well as hanging. The plain hang mode above does not
      # cover the timeout branch's stop: a busy loop dies on the default TERM
      # disposition, so kill followed by a bare wait returns and the branch
      # looks bounded. A boot that neither becomes ready nor exits is exactly
      # the child least likely to honour a TERM, and that one blocks forever.
      hang-term-ignored) trap '' TERM; while : ; do : ; done ;;
    esac ;;
  daemon) echo "DAEMON-STARTED"; exit 0 ;;
esac
EOF
    chmod +x "$T/bin/node"
    out=$(PATH="$T/bin:$PATH" timeout 60 sh "$ENTRYPOINT" 2>&1)
    code=$?
    if [ "$code" = "$expect_exit" ] && printf '%s' "$out" | grep -q "$expect_text"; then
        echo "PASS $mode (exit=$code)"
    else
        echo "FAIL $mode expected exit=$expect_exit text=$expect_text got exit=$code"
        printf '%s\n' "$out" | tail -3
        failures=$((failures + 1))
    fi
}

# `ready` uses a real `exec sleep 300`, which the stubbed sleep turns into an
# immediate exit — so the supervisor stand-in is alive exactly long enough.
run_case ready  0 "supervisor ready"
run_case byos   0 "no provisioning marker"
run_case refuse 1 "boot refused"
# The one Astra found: never ready, never exits. Must hit the cap and fail,
# not block forever on `wait`.
run_case hang   1 "neither became ready nor exited"
run_case hang-term-ignored 1 "neither became ready nor exited"

# The lifecycle contract, separate from the sequencing one above: after ready,
# the supervisor owns the ledger and the lease watchdog, so its death is a
# container failure and the daemon must not be left running unfenced.
lifecycle_case() {
    mode="$1"; expect_exit="$2"; expect_text="$3"
    cat > "$T/bin/node" <<EOF
#!/bin/sh
case "\$2" in
  managed-boot)
    echo "managed runtime boot: supervisor listening (published)"
    case "$mode" in
      supervisor-dies) exit 0 ;;
      *)               exec sleep 300 ;;
    esac ;;
  daemon)
    echo "DAEMON-STARTED"
    case "$mode" in
      supervisor-dies) exec sleep 300 ;;
      daemon-exits)    exit 7 ;;
    esac ;;
esac
EOF
    chmod +x "$T/bin/node"
    out=$(PATH="$T/bin:$PATH" timeout 60 sh "$ENTRYPOINT" 2>&1)
    code=$?
    if [ "$code" = "$expect_exit" ] && printf '%s' "$out" | grep -q "$expect_text"; then
        echo "PASS $mode (exit=$code)"
    else
        echo "FAIL $mode expected exit=$expect_exit text=$expect_text got exit=$code"
        printf '%s\n' "$out" | tail -3
        failures=$((failures + 1))
    fi
}

# `sleep` is stubbed to exit 0, so `exec sleep 0` and `exec sleep 300` both end
# immediately — which is how the supervisor stand-in is made to die first.
lifecycle_case supervisor-dies 1 "supervisor exited; stopping the daemon"

# A child that ignores TERM must not hang the shutdown. `wait` on such a child
# never returns, so the handler has to poll and then KILL.
term_case() {
    cat > "$T/bin/node" <<'EOF'
#!/bin/sh
case "$2" in
  managed-boot) echo "managed runtime boot: supervisor listening (published)"; exec sleep 300 ;;
  daemon)
    trap '' TERM
    echo "DAEMON-STARTED"
    exec sleep 300 ;;
esac
EOF
    chmod +x "$T/bin/node"
    PATH="$T/bin:$PATH" sh "$ENTRYPOINT" >"$T/term.out" 2>&1 &
    entry_pid=$!
    # Give it time to reach the watch loop, then ask it to stop.
    sleep 2
    kill -TERM "$entry_pid" 2>/dev/null
    waited=0
    while [ "$waited" -lt 40 ]; do
        kill -0 "$entry_pid" 2>/dev/null || break
        sleep 1
        waited=$((waited + 1))
    done
    if kill -0 "$entry_pid" 2>/dev/null; then
        kill -KILL "$entry_pid" 2>/dev/null
        echo "FAIL term-ignored: entrypoint still running ${waited}s after TERM"
        failures=$((failures + 1))
    else
        wait "$entry_pid" 2>/dev/null
        echo "PASS term-ignored (exited ${waited}s after TERM)"
    fi
}
term_case
# The daemon's own exit status reaches the container rather than being masked.
lifecycle_case daemon-exits    7 "DAEMON-STARTED"

if [ "$failures" -gt 0 ]; then
    echo "FAILED: $failures branch(es)"
    exit 1
fi
echo "OK: all branches passed"
exit 0
