# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import pathlib
import subprocess
import tempfile
import unittest

import tomllib

ROOT = pathlib.Path(__file__).resolve().parents[3]
MANIFEST = ROOT / "wildbuzzard" / "FEATURE-OWNERSHIP.toml"


class FeatureOwnershipTests(unittest.TestCase):
    def test_external_feature_paths_are_absent(self):
        manifest = tomllib.loads(MANIFEST.read_text(encoding="utf-8"))
        forbidden = {
            path
            for feature in manifest["feature"]
            for path in feature.get("forbidden_browser_paths", [])
        }
        present = sorted(path for path in forbidden if (ROOT / path).exists())
        self.assertEqual(present, [])

    def test_owned_feature_paths_are_present(self):
        manifest = tomllib.loads(MANIFEST.read_text(encoding="utf-8"))
        required = {
            path
            for feature in manifest["feature"]
            if feature["status"] in {"core", "builtin-extension"}
            for path in feature.get("paths", [])
        }
        missing = sorted(path for path in required if not (ROOT / path).exists())
        self.assertEqual(missing, [])

    def test_removed_modules_have_no_build_registration(self):
        roots = [
            ROOT / "browser",
            ROOT / "remote",
            ROOT / "toolkit" / "components" / "search",
            ROOT / "wildbuzzard" / "browser",
        ]
        names = {"components.conf", "jar.mn", "moz.build"}
        manifests = []
        for root in roots:
            manifests.extend(
                path
                for path in root.rglob("*")
                if path.name in names or path.suffix == ".toml"
            )
        manifests.extend([
            ROOT / "browser" / "components" / "DesktopActorRegistry.sys.mjs",
            ROOT / "wildbuzzard" / "browser" / "components" / "WildBuzzardGlue.sys.mjs",
        ])
        removed = [
            "AboutAgent",
            "AboutSearXNG",
            "ManagedSearXNGEngine",
            "QBittorrentSearchBridge",
            "SearXNGManager",
            "SearXNGUDSTransport",
            "TorrentAgentTools",
            "TorrentDiscoveryManager",
            "UrlbarProviderTorrentSearch",
            "agent-sidebar",
            "about:agent",
        ]
        hits = []
        for path in manifests:
            text = path.read_text(encoding="utf-8")
            hits.extend(
                f"{path.relative_to(ROOT)}: {marker}"
                for marker in removed
                if marker in text
            )
        self.assertEqual(hits, [])

    def test_builtin_search_dump_is_not_managed_search(self):
        path = (
            ROOT / "services" / "settings" / "dumps" / "main" / "search-config-v2.json"
        )
        dump = json.loads(path.read_text(encoding="utf-8"))
        serialized = json.dumps(dump, sort_keys=True)
        self.assertGreater(len(dump["data"]), 100)
        self.assertNotIn("searxng", serialized.lower())
        self.assertNotIn("search.wildbuzzard.invalid", serialized)
        defaults = [
            record
            for record in dump["data"]
            if record.get("recordType") == "defaultEngines"
        ]
        self.assertEqual(len(defaults), 1)
        self.assertEqual(defaults[0]["globalDefault"], "ddg")
        self.assertEqual(defaults[0]["specificDefaults"], [])
        duckduckgo = [
            record for record in dump["data"] if record.get("identifier") == "ddg"
        ]
        self.assertEqual(len(duckduckgo), 1)
        self.assertEqual(
            duckduckgo[0]["base"]["urls"]["search"]["base"],
            "https://duckduckgo.com/",
        )
        constants = (
            ROOT
            / "wildbuzzard"
            / "browser"
            / "extensions"
            / "web-search"
            / "extension"
            / "common"
            / "constants.js"
        ).read_text(encoding="utf-8")
        self.assertIn('provider: "ddgs"', constants)

    def test_removed_managed_search_has_no_uri_fixup_exception(self):
        source = (ROOT / "docshell" / "base" / "URIFixup.sys.mjs").read_text(
            encoding="utf-8"
        )
        self.assertNotIn("isWildBuzzardInternalSearch", source)
        self.assertNotIn("about:searxng", source)
        self.assertNotIn('engine.id === "searxng"', source)

    def test_browser_packagers_enforce_component_boundary(self):
        packagers = [
            ROOT / "wildbuzzard" / "scripts" / "package-appimage.sh",
            ROOT / "wildbuzzard" / "scripts" / "package-deb.sh",
        ]
        excluded = [
            "runtime/search",
            "runtime/pi-web",
            "runtime/torrent",
            "runtime/jackett-mini",
        ]
        for path in packagers:
            text = path.read_text(encoding="utf-8")
            for payload in excluded:
                self.assertIn(payload, text, f"{path.name}: {payload}")
        appimage = packagers[0].read_text(encoding="utf-8")
        self.assertIn("ln -s ../lib/wildbuzzard/wildbuzzard", appimage)
        self.assertNotIn("wildbuzzard-native-client", appimage)

    def test_browser_deb_keeps_discovery_clis_optional(self):
        source = (ROOT / "wildbuzzard" / "scripts" / "package-deb.sh").read_text(
            encoding="utf-8"
        )
        control = source.split('cat >"${stage}/DEBIAN/control" <<EOF', 1)[1]
        depends = next(
            line for line in control.splitlines() if line.startswith("Depends:")
        )
        suggests = next(
            line for line in control.splitlines() if line.startswith("Suggests:")
        )
        self.assertNotIn("buzzard-torrent", depends)
        self.assertNotIn("buzzard-search", depends)
        self.assertNotIn("buzzard-minijtt", depends)
        self.assertEqual(suggests, "Suggests: buzzard-search, buzzard-minijtt")

    def test_browser_deb_requires_exactly_one_browser_archive(self):
        script = ROOT / "wildbuzzard" / "scripts" / "package-deb.sh"
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            dist = root / "dist"
            output = root / "output"
            dist.mkdir()
            for version in ("153.1.0", "153.1.1"):
                (dist / f"wildbuzzard-{version}.en-US.linux-x86_64.tar.xz").touch()
            tor = root / "tor"
            torrent = root / "torrent"
            tor.mkdir()
            torrent.mkdir()
            result = subprocess.run(
                [
                    "bash",
                    str(script),
                    "--dist-dir",
                    str(dist),
                    "--output-dir",
                    str(output),
                    "--tor-dir",
                    str(tor),
                    "--qbittorrent-runtime",
                    str(torrent),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Expected exactly one", result.stderr)

    def test_browser_deb_only_assembles_prebuilt_components(self):
        source = (ROOT / "wildbuzzard" / "scripts" / "package-deb.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn("--tor-dir", source)
        self.assertIn("--qbittorrent-runtime", source)
        self.assertNotIn("--cli-binary", source)
        self.assertNotIn("cargo build", source)
        self.assertIn('"${script_dir}/tor-runtime-provenance.py" validate', source)
        self.assertNotIn('"${script_dir}/tor-runtime-provenance.py" create', source)
        self.assertNotIn("node ", source)

    def test_project_package_identity_is_authenticated(self):
        identity = (
            "openresearchtools <229047507+openresearchtools@users.noreply.github.com>"
        )
        metadata = [ROOT / "wildbuzzard" / "scripts" / "package-deb.sh"]
        for path in metadata:
            source = path.read_text(encoding="utf-8")
            self.assertIn(identity, source, path)
            self.assertNotIn("maintainers@openresearchtools.org", source, path)

    def test_only_wildbuzzard_builtins_are_exposed_in_addons_ui(self):
        source = (
            ROOT / "toolkit" / "mozapps" / "extensions" / "content" / "aboutaddons.mjs"
        ).read_text(encoding="utf-8")
        self.assertIn('"web-search@extensions.wildbuzzard"', source)
        self.assertIn('"torrent-search@extensions.wildbuzzard"', source)
        self.assertIn("VISIBLE_BUILTIN_EXTENSION_IDS.has(addon.id)", source)


if __name__ == "__main__":
    unittest.main()
