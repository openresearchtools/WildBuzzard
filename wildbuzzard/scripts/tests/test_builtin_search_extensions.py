# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "wildbuzzard" / "scripts" / "sync_builtin_search_extensions.py"
SPEC = importlib.util.spec_from_file_location("sync_builtin_search_extensions", SCRIPT)
SYNC = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC)


class BuiltinSearchExtensionTests(unittest.TestCase):
    def test_bundled_copies_are_self_consistent(self):
        subprocess.run(
            [sys.executable, str(SCRIPT), "check", "--bundled-only"],
            cwd=ROOT,
            check=True,
        )

    def test_default_sibling_sources_match_when_available(self):
        source = ROOT.parent / SYNC.WEB.repository
        if not source.is_dir():
            self.skipTest("canonical sibling repository is not present")
        subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "check",
                "--extensions-source",
                str(source),
            ],
            cwd=ROOT,
            check=True,
        )

    def test_manifest_policy_fails_closed(self):
        with tempfile.TemporaryDirectory(
            prefix="wildbuzzard-extension-policy-"
        ) as temporary:
            bundle = Path(temporary) / SYNC.WEB.slug
            shutil.copytree(SYNC.EXTENSIONS_ROOT / SYNC.WEB.slug, bundle)
            manifest_path = bundle / "extension" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["permissions"].append("<all_urls>")
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(
                SYNC.ValidationError, "manifest policy mismatch"
            ):
                SYNC.validate_bundle(SYNC.WEB, bundle)

    def test_computed_network_and_browser_aliases_fail_closed(self):
        original = {
            relative: (
                SYNC.EXTENSIONS_ROOT / SYNC.WEB.slug / "extension" / relative
            ).read_bytes()
            for relative in SYNC.WEB.files
        }
        for source in (
            b'\nbrowser["search"];\n',
            b'\nglobalThis["fe" + "tch"];\n',
        ):
            with self.subTest(source=source):
                files = dict(original)
                files["search/search.js"] += source
                with self.assertRaisesRegex(
                    SYNC.ValidationError, "computed or aliased"
                ):
                    SYNC.validate_files(SYNC.WEB, files)

    def test_external_lock_pins_regenerated_bundle(self):
        rendered = {
            config.slug: SYNC.validate_bundle(
                config, SYNC.EXTENSIONS_ROOT / config.slug
            )
            for config in SYNC.CONFIGS
        }
        web_files = {
            relative: rendered[SYNC.WEB.slug][f"extension/{relative}"]
            for relative in SYNC.WEB.files
        }
        web_files["common/base.css"] += b"\n"
        manifest = SYNC.validate_files(SYNC.WEB, web_files)
        tampered = dict(rendered)
        tampered[SYNC.WEB.slug] = SYNC.render_bundle(SYNC.WEB, web_files, manifest)
        with self.assertRaisesRegex(SYNC.ValidationError, "source lock differs"):
            SYNC.validate_lock(tampered)

    def test_sync_rolls_back_both_extensions_as_one_transaction(self):
        rendered = {
            config.slug: SYNC.validate_bundle(
                config, SYNC.EXTENSIONS_ROOT / config.slug
            )
            for config in SYNC.CONFIGS
        }
        with tempfile.TemporaryDirectory(
            prefix="wildbuzzard-sync-transaction-"
        ) as temporary:
            extension_root = Path(temporary) / "extensions"
            extension_root.mkdir()
            for config in SYNC.CONFIGS:
                shutil.copytree(
                    SYNC.EXTENSIONS_ROOT / config.slug,
                    extension_root / config.slug,
                )
            lock = extension_root / SYNC.SOURCE_LOCK.name
            lock.write_bytes(SYNC.SOURCE_LOCK.read_bytes())
            before = {
                config.slug: SYNC.tree_hash(
                    SYNC.bundle_files(config, extension_root / config.slug)
                )
                for config in SYNC.CONFIGS
            }
            original_root = SYNC.EXTENSIONS_ROOT
            original_lock = SYNC.SOURCE_LOCK
            real_replace = SYNC.os.replace
            calls = 0

            def fail_fifth_replace(source, destination):
                nonlocal calls
                calls += 1
                if calls == 5:
                    raise OSError("injected transaction failure")
                return real_replace(source, destination)

            try:
                SYNC.EXTENSIONS_ROOT = extension_root
                SYNC.SOURCE_LOCK = lock
                with mock.patch.object(
                    SYNC.os, "replace", side_effect=fail_fifth_replace
                ):
                    with self.assertRaisesRegex(
                        OSError, "injected transaction failure"
                    ):
                        SYNC.replace_outputs(rendered)
            finally:
                SYNC.EXTENSIONS_ROOT = original_root
                SYNC.SOURCE_LOCK = original_lock
            after = {
                config.slug: SYNC.tree_hash(
                    SYNC.bundle_files(config, extension_root / config.slug)
                )
                for config in SYNC.CONFIGS
            }
            self.assertEqual(after, before)
            self.assertEqual(lock.read_bytes(), SYNC.SOURCE_LOCK.read_bytes())
            self.assertEqual(
                list(extension_root.glob(".builtin-search-transaction-*")), []
            )

    def test_product_build_registers_both_builtin_addons(self):
        product_build = (
            ROOT / "wildbuzzard" / "browser" / "extensions" / "moz.build"
        ).read_text(encoding="utf-8")
        self.assertIn('"web-search"', product_build)
        self.assertIn('"torrent-search"', product_build)
        self.assertIn(":generate_build_lock", product_build)
        self.assertIn("validated_sources.force = True", product_build)
        for config in SYNC.CONFIGS:
            bundle_build = (SYNC.EXTENSIONS_ROOT / config.slug / "moz.build").read_text(
                encoding="utf-8"
            )
            self.assertIn(
                f'FINAL_TARGET_FILES.chrome.browser["builtin-addons"]["{config.slug}"]',
                bundle_build,
            )
            self.assertNotIn("nativeMessaging", bundle_build)

    def test_both_extensions_are_sourced_from_one_monorepo(self):
        self.assertEqual(
            {config.repository for config in SYNC.CONFIGS},
            {"wildbuzzard-extensions"},
        )
        self.assertEqual(
            {config.source_path for config in SYNC.CONFIGS},
            {"extensions/web-search", "extensions/torrent-search"},
        )

    def test_source_lock_records_browser_cli_boundary(self):
        lock = json.loads(SYNC.SOURCE_LOCK.read_text(encoding="utf-8"))
        self.assertEqual(lock["schema"], 3)
        entries = {entry["slug"]: entry for entry in lock["extensions"]}
        for config in SYNC.CONFIGS:
            entry = entries[config.slug]
            self.assertEqual(entry["componentRole"], "browser-ui-only")
            self.assertEqual(
                entry["backendRole"],
                "standalone-system-cli-no-browser-or-web-ui",
            )
            self.assertEqual(entry["backendPackage"], config.backend_package)
            self.assertEqual(entry["backendExecutable"], config.backend_executable)
            self.assertEqual(
                entry["backendInstallCommand"],
                f"sudo apt install {config.backend_package}",
            )


if __name__ == "__main__":
    unittest.main()
