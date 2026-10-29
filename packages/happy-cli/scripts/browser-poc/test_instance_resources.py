import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('instance_server', Path(__file__).parent / 'images/instance-server.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class ResourcesTest(unittest.TestCase):
    def test_browser_cgroup_limits_override_large_host(self):
        values = {'meminfo': 'MemTotal: 67108864 kB\nMemAvailable: 33554432 kB',
                  'cpu.max': '200000 100000', 'cpu.stat': 'usage_usec 123456',
                  'memory.max': '2147483648', 'memory.current': '536870912',
                  'pids.max': '512', 'pids.current': '30'}
        with patch.object(Path, 'read_text', lambda path: values[path.name]):
            result = module.resources()
        self.assertEqual(result['memoryLimitBytes'], 2147483648)
        self.assertEqual(result['memoryUsedBytes'], 536870912)
        self.assertEqual(result['hostAvailableBytes'], 34359738368)
        self.assertEqual(result['cpuLimit'], 2)
        self.assertEqual(result['cpuUsageUsec'], 123456)
    def test_missing_controller_is_not_an_unbounded_capacity(self):
        with patch.object(Path, 'read_text', side_effect=FileNotFoundError):
            with self.assertRaises(OSError): module.resources()

if __name__ == '__main__': unittest.main()
