#!/bin/bash
# Root-only: create a temporary hidden test account, run the live egress check as it, ALWAYS delete it.
#   sudo scripts/agent-browser/native/macEgressFence.account.sh <evidence-dir>
# Changes: one role account + group (_saycodetest, uid/gid 471), one LaunchDaemon label
# com.saycode.egresstest, one pf sub-anchor, files under /private/tmp/saycode-egress-*. No other state.
set -u
OUT="${1:?evidence dir}"
NAME=_saycodetest; ID=471; LABEL=com.saycode.egresstest
PLIST=/Library/LaunchDaemons/$LABEL.plist; WORK=/private/var/tmp/saycode-egresstest
HERE="$(cd "$(dirname "$0")/../../.." && pwd)"
[ "$(id -u)" = 0 ] || { echo "run with sudo"; exit 1; }
[ -n "${SUDO_UID:-}" ] || { echo "run via sudo from your user"; exit 1; }
export SUDO_UID; SUDO_GID="${SUDO_GID:-$(id -g "$SUDO_UID")}"; export SUDO_GID
mkdir -p "$OUT"
LOG="$OUT/account-run.log"; : > "$LOG"; chown "$SUDO_UID:$SUDO_GID" "$LOG"; exec > >(tee -a "$LOG") 2>&1
if dscl . -read /Users/$NAME >/dev/null 2>&1 || dscl . -read /Groups/$NAME >/dev/null 2>&1; then echo "$NAME already exists; remove it first"; exit 1; fi
if dscl . -list /Users UniqueID | awk '{print $2}' | grep -qx $ID || dscl . -list /Groups PrimaryGroupID | awk '{print $2}' | grep -qx $ID; then echo "id $ID in use"; exit 1; fi
if [ -e "$PLIST" ] || [ -e "$WORK" ]; then echo "leftover $PLIST or $WORK"; exit 1; fi

cleanup() {
  launchctl bootout system/$LABEL >/dev/null 2>&1; rm -f "$PLIST"; rm -rf "$WORK"
  pfctl -a com.apple/050.SaycodeNativeH -F all >/dev/null 2>&1
  launchctl bootout user/$ID >/dev/null 2>&1; pkill -9 -U $ID >/dev/null 2>&1; sleep 1; pkill -9 -U $ID >/dev/null 2>&1
  dscl . -delete /Users/$NAME >/dev/null 2>&1; dscl . -delete /Groups/$NAME >/dev/null 2>&1
  {
    echo "userGone=$(dscl . -read /Users/$NAME >/dev/null 2>&1 && echo false || echo true)"
    echo "groupGone=$(dscl . -read /Groups/$NAME >/dev/null 2>&1 && echo false || echo true)"
    echo "plistGone=$([ -e "$PLIST" ] && echo false || echo true)"
    echo "workGone=$([ -e "$WORK" ] && echo false || echo true)"
    echo "anchorEmpty=$([ -z "$(pfctl -a com.apple/050.SaycodeNativeH -s rules 2>/dev/null)" ] && echo true || echo false)"
    echo "uidProcesses=$(ps -axo uid= | awk -v u=$ID '$1==u' | wc -l | tr -d ' ')"
  } > "$OUT/account-cleanup.txt"
  chown "$SUDO_UID:$SUDO_GID" "$OUT/account-cleanup.txt" 2>/dev/null
  echo "--- cleanup ---"; cat "$OUT/account-cleanup.txt"
}
trap cleanup EXIT INT TERM

dscl . -create /Groups/$NAME && dscl . -create /Groups/$NAME PrimaryGroupID $ID || exit 1
dscl . -create /Users/$NAME && dscl . -create /Users/$NAME UniqueID $ID && dscl . -create /Users/$NAME PrimaryGroupID $ID \
  && dscl . -create /Users/$NAME UserShell /usr/bin/false && dscl . -create /Users/$NAME RealName "Saycode egress test" \
  && dscl . -create /Users/$NAME NFSHomeDirectory $WORK/home && dscl . -create /Users/$NAME IsHidden 1 || exit 1
mkdir -p $WORK/home && chown -R $ID:$ID $WORK && chmod 700 $WORK/home
echo "account: $(dscl . -read /Users/$NAME UniqueID | tr -d '\n')"

# Chrome launch-mode diagnosis lives in evidence/2026-10-20/e125-mac-egress-fence/chrome-account-diag*/ (startup ~18-27s).

# Variant 2: the full live fence check with the real account.
cd "$HERE" || exit 1
SAYCODE_FENCE_ACCOUNT=$NAME SAYCODE_FENCE_UID=$ID "$(command -v node)" --import tsx scripts/agent-browser/native/macEgressFence.live.check.ts "$OUT/live-account.json" "$SUDO_UID" "$SUDO_GID"
echo "live check exit=$?"
