import importlib.util
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("capture_helper", Path(__file__).resolve().parents[1] / "scripts/inspect_capture.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "capture.pcap"
        self.path.touch()

    def mock_result(self, stdout, code=0, stderr=""):
        with patch.object(helper.shutil, "which", return_value="/tool/capinfos"), patch.object(helper.subprocess, "run", return_value=subprocess.CompletedProcess([], code, stdout, stderr)) as run:
            result = helper.inspect_capture(self.path)
            self.assertEqual(run.call_args.kwargs["timeout"], 60)
            self.assertNotIn("shell", run.call_args.kwargs)
            return result

    def test_zero(self):
        self.assertEqual(self.mock_result("Number of packets: 0\n")["status"], "unusable")

    def test_valid(self):
        result = self.mock_result("Number of packets: 2\nFirst packet time: 100.000000001\nLast packet time: 102.1\n")
        self.assertEqual(result["status"], "usable")
        self.assertEqual(result["first_epoch"], "100.000000001")

    def test_failed_reader(self):
        self.assertEqual(self.mock_result("Number of packets: 10", 1, "truncated")["status"], "unusable")

    def test_unknown_range(self):
        self.assertEqual(self.mock_result("Number of packets: 2")["status"], "partial")

    def test_invalid_range(self):
        self.assertEqual(self.mock_result("Number of packets: 2\nEarliest packet time: nan\nLatest packet time: inf")["status"], "partial")

    def test_reader_warning(self):
        result = self.mock_result("Number of packets: 2\nFirst packet time: 1\nLast packet time: 2", stderr="reader warning")
        self.assertEqual(result["status"], "partial")

    def test_bad_count(self):
        self.assertEqual(self.mock_result("Number of packets: invalid")["status"], "not inspected")

    def test_missing_tool(self):
        with patch.object(helper.shutil, "which", return_value=None):
            self.assertEqual(helper.inspect_capture(self.path)["status"], "not inspected")

    def test_etl(self):
        etl = self.path.with_suffix(".etl")
        etl.touch()
        with patch.object(helper.subprocess, "run") as run:
            self.assertIn("unsupported", helper.inspect_capture(etl)["reason"])
            run.assert_not_called()

    def test_timeout(self):
        with patch.object(helper.shutil, "which", return_value="capinfos"), patch.object(helper.subprocess, "run", side_effect=subprocess.TimeoutExpired("capinfos", 60)):
            self.assertEqual(helper.inspect_capture(self.path)["status"], "not inspected")

    @unittest.skipUnless(shutil.which("capinfos"), "capinfos unavailable")
    def test_real_pcap(self):
        header = struct.pack("<IHHIIII", 0xa1b2c3d4, 2, 4, 0, 0, 65535, 1)
        self.path.write_bytes(header)
        self.assertEqual(helper.inspect_capture(self.path)["status"], "unusable")
        self.path.write_bytes(header + struct.pack("<IIII", 1700000000, 250000, 14, 14) + bytes(14))
        result = helper.inspect_capture(self.path)
        self.assertEqual(result["status"], "usable", result)
        self.assertEqual(result["packet_count"], 1)
        self.path.write_bytes(header + struct.pack("<IIII", 1700000000, 250000, 14, 14) + bytes(4))
        self.assertEqual(helper.inspect_capture(self.path)["status"], "unusable")


if __name__ == "__main__":
    unittest.main()
