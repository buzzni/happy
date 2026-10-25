#!/bin/bash
# Root-only N4 measurement: with the content-filter probe enabled, run network cases as a temporary
# hidden account and record when each ran. The filter's own log (subsystem
# com.saycode.nativeh.nefilterprobe) is read afterwards and joined by uid and time.
# Creates the account and ALWAYS deletes it. Does not grant installed authority (nativeReady OFF).
#   sudo ./measure.sh <phase-label> <results.json>
# Manual recovery: sudo pkill -9 -U 471; sudo dscl . -delete /Users/_saycodetest;
#   sudo dscl . -delete /Groups/_saycodetest; sudo rm -rf /private/var/tmp/saycode-nefilter
set -uo pipefail
PHASE=${1:?phase label}; OUT=${2:?results.json}
NAME=_saycodetest; ID=471; WORK=/private/var/tmp/saycode-nefilter; PORT=18471
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
dscl . -read /Users/$NAME >/dev/null 2>&1 && { echo "$NAME already exists"; exit 1; }
[ -z "$(dscl . -search /Users UniqueID $ID)" ] || { echo "uid $ID in use"; exit 1; }
LAN=$(ipconfig getifaddr "$(route -n get default | awk '/interface:/{print $2}')")
[ -n "$LAN" ] || { echo "no LAN IPv4 address"; exit 1; }

cleanup() {
  kill "${SERVER:-0}" 2>/dev/null
  for _ in $(seq 50); do pgrep -U $ID >/dev/null || break; pkill -9 -U $ID; sleep 0.2; done
  launchctl bootout user/$ID 2>/dev/null; pkill -9 -U $ID 2>/dev/null
  dscl . -delete /Users/$NAME 2>/dev/null; dscl . -delete /Groups/$NAME 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

dscl . -create /Groups/$NAME PrimaryGroupID $ID
for kv in "UniqueID $ID" "PrimaryGroupID $ID" "UserShell /usr/bin/false" "NFSHomeDirectory $WORK/home" "IsHidden 1"; do
  dscl . -create /Users/$NAME $kv
done
mkdir -p "$WORK/home" && chown -R $ID:$ID "$WORK" && chmod 700 "$WORK/home"
/usr/bin/python3 -m http.server $PORT --bind 0.0.0.0 --directory /var/empty >/dev/null 2>&1 & SERVER=$!
sleep 1

label() { echo "saycode-nefprobe-$(openssl rand -hex 5)"; }
as() { sudo -u $NAME -H env HOME="$WORK/home" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$@"; }
CASES=()
LABELS=()
run() { # name, then command run as the account (killed after 25 s; KILL_AFTER overrides, in seconds)
  local name=$1; shift
  local start; start=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  as /usr/bin/perl -MTime::HiRes=alarm -e 'alarm shift; exec @ARGV' "${KILL_AFTER:-25}" "$@" >/dev/null 2>&1; local rc=$?
  sleep 1
  CASES+=("{\"case\":\"$name\",\"start\":\"$start\",\"end\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"exit\":$rc,\"argv\":\"$(echo "$*" | sed 's/"/\\"/g')\"}")
}

L1=$(label); LABELS+=("\"system-resolver-dns\":\"$L1\""); run system-resolver-dns /usr/bin/dscacheutil -q host -a name "$L1.example.org"
# Ask the system resolver, then exit almost at once: is the first query still attributed to this uid?
for s in 0.02 0.1 0.5; do
  L=$(label); LABELS+=("\"dns-exit-${s}s\":\"$L\""); KILL_AFTER=$s run "dns-exit-${s}s" /usr/bin/dscacheutil -q host -a name "$L.example.org"
done
L2=$(label); LABELS+=("\"direct-udp-dns\":\"$L2\""); run direct-udp-dns /usr/bin/dig +time=3 +tries=1 @1.1.1.1 "$L2.example.org"
run icmp-ping /sbin/ping -c 2 -t 4 1.1.1.1
run own-lan-address /usr/bin/curl -sS -m 5 -o /dev/null "http://$LAN:$PORT/"
run loopback /usr/bin/curl -sS -m 5 -o /dev/null "http://127.0.0.1:$PORT/"
run external-https /usr/bin/curl -sS -m 8 -o /dev/null https://example.com/
L3=$(label); LABELS+=("\"chrome-unproxied-dns\":\"$L3\""); run chrome-unproxied-dns "$CHROME" --headless=new --no-first-run --no-default-browser-check --disable-extensions \
  --disable-background-networking --disable-sync --disable-component-update --password-store=basic --use-mock-keychain \
  --user-data-dir="$WORK/home/chrome" --timeout=8000 --dump-dom "https://$L3.example.org/"
sleep 30 # let mDNSResponder finish retries for names whose requester is gone

{
  echo "{\"kind\":\"mac-ne-filter-probe-live\",\"phase\":\"$PHASE\",\"nativeReady\":false,\"uid\":$ID,\"lan\":\"$LAN\",\"port\":$PORT,"
  echo " \"labels\":{$(IFS=,; echo "${LABELS[*]}")},"
  echo " \"cases\":[$(IFS=,; echo "${CASES[*]}")]}"
} > "$OUT"
chown "${SUDO_UID:-0}:${SUDO_GID:-0}" "$OUT"
echo "wrote $OUT"
