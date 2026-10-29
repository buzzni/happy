#!/usr/bin/env python3
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
from pathlib import Path


def resources():
    # This process lives with Chromium: never sample the runtime container instead.
    cg = Path('/sys/fs/cgroup')
    mem = {line.split(':')[0]: int(line.split()[1]) * 1024
           for line in Path('/proc/meminfo').read_text().splitlines() if ':' in line}
    def limit(name, fallback):
        value = (cg / name).read_text().strip()
        return fallback if value == 'max' else int(value)
    cpu = (cg / 'cpu.max').read_text().split()
    import os
    cpu_limit = (os.cpu_count() or 1) if cpu[0] == 'max' else int(cpu[0]) / int(cpu[1])
    cpu_stat = dict(line.split() for line in (cg / 'cpu.stat').read_text().splitlines())
    return dict(version=1, hostAvailableBytes=mem['MemAvailable'],
                memoryLimitBytes=limit('memory.max', mem['MemTotal']),
                memoryUsedBytes=int((cg / 'memory.current').read_text()),
                cpuLimit=cpu_limit, cpuUsageUsec=int(cpu_stat['usage_usec']),
                pidsLimit=limit('pids.max', 512), pidsUsed=int((cg / 'pids.current').read_text()))

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/instance', '/resources'):
            self.send_error(404)
            return
        try:
            if self.path == '/resources':
                data = json.dumps(resources()).encode()
            else:
                with open('/run/abp/instance.json', 'rb') as f:
                    data = f.read()
        except (OSError, ValueError, KeyError, ZeroDivisionError):
            self.send_error(503)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)
    def log_message(self, *args):
        pass
if __name__ == '__main__':
    HTTPServer(('0.0.0.0', 9224), Handler).serve_forever()
