#!/bin/sh
set -eu
export DISPLAY=:99
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
# The viewer is the only human input path, so it must authenticate: the harness
# (standing in for the relay) hands the per-run password to the user's viewer only.
test -n "${ABP_VNC_PASSWORD:-}"
x11vnc -storepasswd "$ABP_VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
x11vnc -display :99 -rfbport 5900 -localhost -forever -shared -rfbauth /tmp/vncpass >/tmp/x11vnc.log 2>&1 &
websockify --web /usr/share/novnc/ 0.0.0.0:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9225 &
python3 /usr/local/bin/cdp-proxy &
python3 /usr/local/bin/instance-server &
while :; do
  rm -f /home/browser/profile/Singleton*
  # Drop the previous identity before the new Chromium can accept CDP
  # connections, so a reconnecting Runtime can never pair the new browser
  # with the old browserInstanceId.
  rm -f /run/abp/instance.json
  browser_id=$(cat /proc/sys/kernel/random/uuid)
  chromium --user-data-dir=/home/browser/profile --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --site-per-process --no-first-run --no-default-browser-check --disable-dev-shm-usage --disable-crash-reporter --disable-breakpad --no-sandbox --display=:99 --host-resolver-rules="${ABP_HOST_RULES:-MAP *.poc-one.test 127.0.0.1,MAP *.poc-two.test 127.0.0.1,MAP *.poc-three.test 127.0.0.1}" about:blank >/tmp/chromium.log 2>&1 &
  chrome_pid=$!
  printf '{"browserInstanceId":"%s","chromePid":%s,"startedAtMs":%s}\n' "$browser_id" "$chrome_pid" "$(($(date +%s)*1000))" > /run/abp/instance.json.tmp
  mv /run/abp/instance.json.tmp /run/abp/instance.json
  wait "$chrome_pid" || true
  sleep 1
done
