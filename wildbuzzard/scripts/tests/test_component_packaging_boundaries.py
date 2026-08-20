#!/usr/bin/env python3

import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"


class ComponentPackagingBoundaryTests(unittest.TestCase):
    def test_browser_build_does_not_embed_external_component_archives(self):
        paths = (
            ROOT / "moz.configure",
            ROOT / "moz.build",
            SCRIPTS / "build-linux-external.sh",
            SCRIPTS / "package-appimage.sh",
            SCRIPTS / "package-deb.sh",
        )
        forbidden = (
            "validate-host-native-runtime-archive.py",
            "torrent-runtime-lock.json",
            "jackett-mini-runtime-lock.json",
            "copy_validated_host_native_runtime.py",
            "validate-pi-web-runtime-archive.py",
            "pi-web-runtime-lock.json",
            "copy_pi_web_runtime.py",
        )
        for path in paths:
            value = path.read_text(encoding="utf-8")
            for name in forbidden:
                self.assertNotIn(name, value, path)


if __name__ == "__main__":
    unittest.main()
