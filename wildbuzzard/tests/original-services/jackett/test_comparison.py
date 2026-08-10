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
LIVE_SPEC = importlib.util.spec_from_file_location(
    "jackett_live_source_report", SCRIPT_DIR / "run-live-source-report.py"
)
LIVE_MODULE = importlib.util.module_from_spec(LIVE_SPEC)
LIVE_SPEC.loader.exec_module(LIVE_MODULE)


class ComparisonHardeningTest(unittest.TestCase):
    def test_product_harnesses_have_no_container_execution_path(self):
        harnesses = (
            SCRIPT_DIR / "run-comparison.py",
            SCRIPT_DIR / "run-live-source-report.py",
            SCRIPT_DIR / "run-comparison-rootless.sh",
        )
        for path in harnesses:
            source = path.read_text(encoding="utf-8").lower()
            with self.subTest(path=path.name):
                self.assertNotIn("podman", source)
                self.assertNotIn("docker", source)
                self.assertNotIn("/app/jackett-mini", source)
                self.assertNotIn("mini-container", source)

    def test_live_report_has_no_oci_runtime_option(self):
        source = (SCRIPT_DIR / "run-live-source-report.py").read_text(encoding="utf-8")
        self.assertNotIn("--oci-runtime", source)
        self.assertIn('"executionBoundary": "direct-host-process"', source)

    def test_comparison_requires_direct_rootless_mode(self):
        source = (SCRIPT_DIR / "run-comparison.py").read_text(encoding="utf-8")
        self.assertIn(
            'parser.error("run-comparison.py requires --direct-rootless")', source
        )

    def test_live_report_records_and_stops_direct_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            process, log = LIVE_MODULE.start_process(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                root,
                dict(os.environ),
                root / "process.log",
            )
            pid_path = root / "process.pid"
            pid_path.write_text(str(process.pid), encoding="ascii")
            try:
                identity = LIVE_MODULE.process_identity(
                    process, pathlib.Path(sys.executable), pid_path
                )
                self.assertEqual(identity["pid"], process.pid)
                self.assertEqual(identity["executionBoundary"], "direct-host-process")
                cleanup = LIVE_MODULE.stop_process(process)
                self.assertIn("SIGINT", cleanup["signals"])
                self.assertTrue(cleanup["processGroupEmpty"])
            finally:
                LIVE_MODULE.stop_process(process)
                log.close()

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
                while (
                    pathlib.Path(f"/proc/{child}").exists()
                    and time.monotonic() < deadline
                ):
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
