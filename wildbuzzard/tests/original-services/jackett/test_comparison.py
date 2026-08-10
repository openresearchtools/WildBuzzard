# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import os
import pathlib
import sys
import tempfile
import time
import unittest


SCRIPT_DIR = pathlib.Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "jackett_comparison", SCRIPT_DIR / "run-comparison.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ComparisonHardeningTest(unittest.TestCase):
    def test_empty_redaction_marker_is_ignored(self):
        self.assertEqual(
            MODULE.redact_bytes(b"unchanged", [("", "<redacted>")]), b"unchanged"
        )
        self.assertEqual(
            MODULE.redact_text("unchanged", [("", "<redacted>")]), "unchanged"
        )

    def test_process_group_cleanup_stops_children(self):
        with tempfile.TemporaryDirectory() as directory:
            child_path = pathlib.Path(directory) / "child.pid"
            parent, log = MODULE.start_process(
                [
                    sys.executable,
                    "-c",
                    (
                        "import pathlib, subprocess, sys, time; "
                        "child=subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                        f"pathlib.Path({str(child_path)!r}).write_text(str(child.pid)); "
                        "time.sleep(60)"
                    ),
                ],
                pathlib.Path(directory),
                dict(os.environ),
                pathlib.Path(directory) / "process.log",
            )
            try:
                deadline = time.monotonic() + 5
                while not child_path.exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue(child_path.exists())
                child = int(child_path.read_text())
                MODULE.stop_process(parent)
                deadline = time.monotonic() + 5
                while pathlib.Path(f"/proc/{child}").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(pathlib.Path(f"/proc/{child}").exists())
            finally:
                MODULE.stop_process(parent)
                log.close()

    def test_rootless_wrapper_audits_kernel_key_quota(self):
        wrapper = (SCRIPT_DIR / "run-comparison-rootless.sh").read_text(
            encoding="utf-8"
        )
        self.assertGreaterEqual(wrapper.count("/proc/key-users"), 2)
        self.assertIn('cmp -s -- "$comparison_key_check/before"', wrapper)


if __name__ == "__main__":
    unittest.main()
