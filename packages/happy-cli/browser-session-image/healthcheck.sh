#!/bin/sh
set -eu

test -s /tmp/happy-browser-paired
pgrep -x chromium >/dev/null
python3 - <<'PY'
import urllib.request
with urllib.request.urlopen('http://127.0.0.1:6080/vnc.html', timeout=2) as response:
    if response.status != 200:
        raise SystemExit(1)
PY
