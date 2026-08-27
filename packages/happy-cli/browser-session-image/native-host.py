#!/usr/bin/env python3
import json
import os
import struct
import sys

raw_length = sys.stdin.buffer.read(4)
if len(raw_length) != 4:
    raise SystemExit(1)
length = struct.unpack('<I', raw_length)[0]
request = json.loads(sys.stdin.buffer.read(length))
if request.get('type') != 'pair':
    raise SystemExit(1)

config = {
    'token': os.environ['HAPPY_BROWSER_BRIDGE_TOKEN'],
    'port': int(os.environ.get('HAPPY_BROWSER_BRIDGE_PORT', '41777')),
    'host': os.environ.get('HAPPY_BROWSER_BRIDGE_HOST', 'host.docker.internal'),
    'viewerKey': os.environ['HAPPY_BROWSER_VIEWER_KEY'],
}
with open('/tmp/happy-browser-paired', 'w', encoding='utf-8') as marker:
    marker.write(config['viewerKey'])
payload = json.dumps({'ok': True, 'config': config}, separators=(',', ':')).encode()
sys.stdout.buffer.write(struct.pack('<I', len(payload)))
sys.stdout.buffer.write(payload)
sys.stdout.buffer.flush()
