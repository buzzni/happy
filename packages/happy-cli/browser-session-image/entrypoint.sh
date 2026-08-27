#!/bin/sh
set -eu

case "${1:-run}" in
  profile-bytes)
    du -sb "${2:?profile path required}" | awk '{print $1}'
    exit 0
    ;;
  migrate-profile)
    source_dir="${2:?source path required}"
    destination_dir="${3:?destination path required}"
    test -z "$(find "$destination_dir" -mindepth 1 -maxdepth 1 -print -quit)"
    cp -a "$source_dir"/. "$destination_dir"/
    exit 0
    ;;
esac

test -n "${HAPPY_BROWSER_VIEWER_KEY:-}"
test -n "${HAPPY_BROWSER_BRIDGE_TOKEN:-}"

# The container name is unique per viewer, so no second Chromium may own this
# volume. These locks contain the previous container hostname and otherwise
# make every crash/restart fail with profile-in-use (exit 21).
rm -f \
  /home/browser/profile/SingletonCookie \
  /home/browser/profile/SingletonLock \
  /home/browser/profile/SingletonSocket

Xvfb :99 -screen 0 1920x1080x24 -ac &
xvfb_pid=$!
attempt=0
while [ ! -S /tmp/.X11-unix/X99 ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 50 ] || ! kill -0 "$xvfb_pid" 2>/dev/null; then
    echo "Xvfb did not become ready" >&2
    exit 1
  fi
  sleep 0.1
done
x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -nopw -quiet &
vnc_pid=$!
websockify --web /usr/share/novnc 0.0.0.0:6080 127.0.0.1:5900 &
web_pid=$!
# Chromium's setuid sandbox cannot operate with no-new-privileges and all
# capabilities dropped. The per-viewer container is the process boundary.
chromium \
  --disable-dev-shm-usage \
  --no-sandbox \
  --display=:99 \
  --user-data-dir=/home/browser/profile \
  --load-extension=/opt/happy/extension \
  --no-first-run \
  about:blank &
chrome_pid=$!

trap 'kill "$chrome_pid" "$web_pid" "$vnc_pid" "$xvfb_pid" 2>/dev/null || true' TERM INT EXIT
wait "$chrome_pid"
