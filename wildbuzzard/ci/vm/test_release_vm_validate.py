#!/usr/bin/env python3

import base64
import copy
import importlib.util
import json
import os
import pathlib
import socket
import struct
import sys
import tempfile
import types
import unittest
import urllib.parse
import urllib.request
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


host = load_module("release_vm_validate", "release-vm-validate.py")
guest = load_module("release_vm_guest_validate", "release-vm-guest-validate.py")


def temporary_directory():
    options = {}
    if host.DATA_ROOT.is_dir() and os.access(host.DATA_ROOT, os.W_OK):
        options["dir"] = host.DATA_ROOT
    return tempfile.TemporaryDirectory(**options)


def valid_manifest():
    return {
        "schemaVersion": 1,
        "artifacts": [
            {
                "architecture": "amd64",
                "filename": f"{package}_1.0_amd64.deb",
                "package": package,
                "sha256": "0" * 64,
                "size": 1,
                "version": "1.0",
            }
            for package in sorted(guest.PACKAGES)
        ],
    }


class GuestManifestTests(unittest.TestCase):
    def test_accepts_only_the_exact_amd64_package_set(self):
        manifest = valid_manifest()
        self.assertEqual(len(guest.manifest_entries(manifest)), 3)

        mutations = []
        duplicate_package = copy.deepcopy(manifest)
        duplicate_package["artifacts"][0]["package"] = duplicate_package["artifacts"][
            1
        ]["package"]
        mutations.append(duplicate_package)
        duplicate_filename = copy.deepcopy(manifest)
        duplicate_filename["artifacts"][0]["filename"] = duplicate_filename[
            "artifacts"
        ][1]["filename"]
        mutations.append(duplicate_filename)
        wrong_architecture = copy.deepcopy(manifest)
        wrong_architecture["artifacts"][0]["architecture"] = "all"
        mutations.append(wrong_architecture)
        unsafe_filename = copy.deepcopy(manifest)
        unsafe_filename["artifacts"][0]["filename"] = "../escape.deb"
        mutations.append(unsafe_filename)
        extra_artifact = copy.deepcopy(manifest)
        extra_artifact["artifacts"].append(
            copy.deepcopy(extra_artifact["artifacts"][0])
        )
        mutations.append(extra_artifact)

        for mutation in mutations:
            with self.subTest(mutation=mutation), self.assertRaises(RuntimeError):
                guest.manifest_entries(mutation)

    def test_rejects_boolean_download_size_before_network_access(self):
        manifest = valid_manifest()
        manifest["artifacts"][0]["size"] = True
        with temporary_directory() as directory, self.assertRaises(RuntimeError):
            guest.download_artifacts(
                manifest, pathlib.Path(directory), "http://127.0.0.1:1"
            )


class HostArtifactTests(unittest.TestCase):
    def test_filters_to_one_exact_regular_deb_per_package(self):
        with temporary_directory() as directory:
            root = pathlib.Path(directory)
            filenames = {
                package: f"{package}_1.0_amd64.deb" for package in sorted(host.PACKAGES)
            }
            for filename in filenames.values():
                (root / filename).write_bytes(b"deb")

            by_filename = {value: key for key, value in filenames.items()}
            relationships = {
                "Depends": "libgtk-3-0 | libgtk-3-0t64",
                "Suggests": "buzzard-search, buzzard-minijtt",
            }

            def package_field(path, field):
                if field == "Package":
                    return by_filename[path.name]
                if field == "Architecture":
                    return "amd64"
                if field == "Version":
                    return "1.0"
                if field in relationships:
                    return relationships[field]
                raise AssertionError(field)

            with mock.patch.object(host, "DATA_ROOT", root), mock.patch.object(
                host, "package_field", side_effect=package_field
            ):
                manifest = host.artifact_manifest(root)
                self.assertEqual(
                    {entry["package"] for entry in manifest["artifacts"]}, host.PACKAGES
                )
                relationships["Depends"] += ", buzzard-search"
                with self.assertRaises(ValueError):
                    host.artifact_manifest(root)
                relationships["Depends"] = "libgtk-3-0"
                relationships["Suggests"] = "buzzard-search"
                with self.assertRaises(ValueError):
                    host.artifact_manifest(root)
                relationships["Suggests"] = "buzzard-search, buzzard-minijtt"
                unexpected = root / "unexpected_1.0_amd64.deb"
                unexpected.write_bytes(b"deb")
                by_filename[unexpected.name] = "unexpected"
                with self.assertRaises(ValueError):
                    host.artifact_manifest(root)


class StoragePreflightTests(unittest.TestCase):
    def storage_xml(self, overlay, backing, *, interface="user"):
        return f"""
        <domain>
          <os><type arch="x86_64">hvm</type></os>
          <devices>
            <disk type="file" device="disk">
              <driver type="qcow2"/>
              <source file="{overlay}"/>
              <backingStore type="file">
                <format type="raw"/>
                <source file="{backing}"/>
              </backingStore>
            </disk>
            <interface type="{interface}"/>
          </devices>
        </domain>
        """

    def test_accepts_data_overlay_and_rejects_unsafe_storage_or_network(self):
        with temporary_directory() as directory, temporary_directory() as other:
            root = pathlib.Path(directory)
            overlay = root / "release-overlay.qcow2"
            backing = root / "pristine.raw"
            outside = pathlib.Path(other) / "system.qcow2"
            for path in (overlay, backing, outside):
                path.write_bytes(b"disk")

            class FakeGuest:
                domain = "release-vm"

                def __init__(self, xml):
                    self.xml = xml

                def virsh(self, *_arguments):
                    return types.SimpleNamespace(stdout=self.xml)

            with mock.patch.object(host, "DATA_ROOT", root):
                host.domain_storage_preflight(
                    FakeGuest(self.storage_xml(overlay, backing))
                )
                with self.assertRaises((RuntimeError, ValueError)):
                    host.domain_storage_preflight(
                        FakeGuest(self.storage_xml(outside, backing))
                    )
                with self.assertRaises(RuntimeError):
                    host.domain_storage_preflight(
                        FakeGuest(
                            self.storage_xml(overlay, backing, interface="network")
                        )
                    )


class QGATests(unittest.TestCase):
    def test_guest_exec_preserves_shell_command_as_one_qga_argument(self):
        client = host.Guest("qemu:///session", "release-vm")
        payloads = []

        def qga(payload):
            payloads.append(payload)
            if payload["execute"] == "guest-exec":
                return {"pid": 7}
            return {
                "exited": True,
                "exitcode": 0,
                "out-data": base64.b64encode(b"ok\n").decode(),
            }

        client.qga = qga
        command = "printf '%s\\n' 'spaces' '$HOME;$(id)' 'single'\\''quote'"
        _, stdout, _ = client.exec(command)
        self.assertEqual(stdout, "ok\n")
        self.assertEqual(payloads[0]["arguments"]["arg"], ["-lc", command])


class RunnerTests(unittest.TestCase):
    def test_timeout_preserves_partial_output_and_marker(self):
        with temporary_directory() as directory:
            log_path = pathlib.Path(directory) / "validation.log"
            runner = guest.Runner(log_path)
            with self.assertRaises(RuntimeError):
                runner.run(
                    [
                        sys.executable,
                        "-c",
                        "import time; print('started', flush=True); time.sleep(5)",
                    ],
                    timeout=0.1,
                )
            log = log_path.read_text(encoding="utf-8")
            self.assertIn("started", log)
            self.assertIn("[timeout after 0.1 seconds]", log)


class AptInstallTests(unittest.TestCase):
    def test_installs_all_local_files_together_and_verifies_versions(self):
        artifacts = valid_manifest()["artifacts"]
        expected = {entry["package"]: entry["version"] for entry in artifacts}
        calls = []

        class FakeRunner:
            def run(self, command, **options):
                calls.append((command, options))
                return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        with temporary_directory() as directory, mock.patch.object(
            guest, "installed_packages", side_effect=[{}, expected]
        ), mock.patch.object(
            guest.pathlib.Path, "is_file", return_value=True
        ), mock.patch.object(guest.os, "access", return_value=True):
            self.assertEqual(
                guest.install_packages(
                    FakeRunner(),
                    artifacts,
                    pathlib.Path(directory),
                    allow_installed=False,
                ),
                expected,
            )
        install = next(
            command
            for command, _options in calls
            if command[:2] == ["apt-get", "install"]
        )
        self.assertIn("--no-install-recommends", install)
        for dependency in guest.TEST_DEPENDENCIES:
            self.assertIn(dependency, install)
        self.assertEqual(
            {
                pathlib.Path(value).name
                for value in install
                if str(value).endswith(".deb")
            },
            {entry["filename"] for entry in artifacts},
        )

    def test_freshness_failure_stops_before_apt(self):
        runner = mock.Mock()
        with mock.patch.object(
            guest, "installed_packages", return_value={"wildbuzzard": "old"}
        ), self.assertRaises(RuntimeError):
            guest.install_packages(
                runner, valid_manifest()["artifacts"], pathlib.Path("/staging"), False
            )
        runner.run.assert_not_called()

    def test_allow_installed_reinstalls_exact_local_files(self):
        artifacts = valid_manifest()["artifacts"]
        expected = {entry["package"]: entry["version"] for entry in artifacts}
        calls = []

        class FakeRunner:
            def run(self, command, **options):
                calls.append((command, options))
                return types.SimpleNamespace(returncode=0, stdout="", stderr="")

        with temporary_directory() as directory, mock.patch.object(
            guest, "installed_packages", side_effect=[expected, expected]
        ), mock.patch.object(
            guest.pathlib.Path, "is_file", return_value=True
        ), mock.patch.object(guest.os, "access", return_value=True):
            guest.install_packages(
                FakeRunner(),
                artifacts,
                pathlib.Path(directory),
                allow_installed=True,
            )
        install = next(
            command
            for command, _options in calls
            if command[:2] == ["apt-get", "install"]
        )
        self.assertIn("--reinstall", install)


class LocalTorrentValidationTests(unittest.TestCase):
    def test_loopback_tracker_and_peer_serve_exact_fixture_bytes(self):
        payload = b"local legal torrent fixture\n" * 1024
        with guest.TorrentFixture(payload) as fixture:
            with urllib.request.urlopen(
                f"{fixture.announce_url}?compact=1", timeout=2
            ) as response:
                tracker = response.read()
            packed_peer = socket.inet_aton("127.0.0.1") + struct.pack(
                ">H", fixture.peer_server.server_address[1]
            )
            self.assertIn(packed_peer, tracker)
            with socket.create_connection(
                fixture.peer_server.server_address, timeout=2
            ) as peer:
                peer.sendall(
                    b"\x13BitTorrent protocol"
                    + (b"\0" * 8)
                    + fixture.info_hash
                    + b"-UT0001-123456789012"
                )
                handshake = guest.read_exact(peer, 68)
                self.assertEqual(handshake[28:48], fixture.info_hash)
                messages = []
                for _ in range(2):
                    length = struct.unpack(">I", guest.read_exact(peer, 4))[0]
                    messages.append(guest.read_exact(peer, length))
                self.assertEqual([message[0] for message in messages], [5, 1])
                peer.sendall(guest.peer_message(2))
                downloaded = bytearray()
                piece_count = (
                    len(payload) + guest.TORRENT_FIXTURE_PIECE_LENGTH - 1
                ) // guest.TORRENT_FIXTURE_PIECE_LENGTH
                for index in range(piece_count):
                    length = min(
                        guest.TORRENT_FIXTURE_PIECE_LENGTH,
                        len(payload) - index * guest.TORRENT_FIXTURE_PIECE_LENGTH,
                    )
                    peer.sendall(
                        guest.peer_message(6, struct.pack(">III", index, 0, length))
                    )
                    message_length = struct.unpack(">I", guest.read_exact(peer, 4))[0]
                    message = guest.read_exact(peer, message_length)
                    self.assertEqual(message[0], 7)
                    self.assertEqual(struct.unpack(">II", message[1:9]), (index, 0))
                    downloaded.extend(message[9:])
            self.assertEqual(bytes(downloaded), payload)
        self.assertEqual(fixture.statistics()["announces"], 1)
        self.assertEqual(fixture.statistics()["servedBytes"], len(payload))

    def test_validates_add_list_details_download_hash_and_safe_delete(self):
        payload = b"validated torrent bytes"
        info_hash = "a" * 40

        class FakeFixture:
            def __init__(self):
                self.payload = payload
                self.info_hash_hex = info_hash
                self.torrent = b"deterministic torrent metadata"

            def __enter__(self):
                return self

            def __exit__(self, *_arguments):
                pass

            def statistics(self):
                return {
                    "announces": 1,
                    "requests": 2,
                    "servedBytes": len(payload),
                }

        calls = []

        def run_wildbuzzard_torrent_json(
            _runner,
            result_dir,
            _account,
            environment,
            label,
            command,
            *,
            timeout=120,
        ):
            calls.append({
                "command": command,
                "environment": environment,
                "label": label,
                "timeout": timeout,
            })
            download_dir = result_dir / "torrent-download"
            if label == "wildbuzzard-torrent-list-initial":
                return {"limit": 50, "torrents": []}
            if label == "wildbuzzard-torrent-add-local-fixture":
                return {"added": True}
            if label == "wildbuzzard-torrent-list-download":
                (download_dir / guest.TORRENT_FIXTURE_NAME).write_bytes(payload)
                return {
                    "limit": 100,
                    "torrents": [
                        {
                            "downloadedBytes": len(payload),
                            "id": info_hash,
                            "name": guest.TORRENT_FIXTURE_NAME,
                            "progress": 1,
                            "savePath": str(download_dir),
                            "sizeBytes": len(payload),
                        }
                    ],
                }
            if label == "wildbuzzard-torrent-details-overview":
                return {
                    "downloadedBytes": len(payload),
                    "id": info_hash,
                    "infohashV1": info_hash,
                    "name": guest.TORRENT_FIXTURE_NAME,
                    "private": True,
                    "totalSizeBytes": len(payload),
                }
            if label == "wildbuzzard-torrent-details-files":
                return {
                    "id": info_hash,
                    "items": [
                        {
                            "name": guest.TORRENT_FIXTURE_NAME,
                            "progress": 1,
                            "sizeBytes": len(payload),
                        }
                    ],
                    "section": "files",
                    "total": 1,
                }
            if label == "wildbuzzard-torrent-control-delete":
                return {"action": "delete", "applied": True, "ids": [info_hash]}
            if label == "wildbuzzard-torrent-list-after-delete":
                return {"limit": 50, "torrents": []}
            raise AssertionError(label)

        with temporary_directory() as directory, mock.patch.object(
            guest, "TorrentFixture", FakeFixture
        ), mock.patch.object(
            guest,
            "run_wildbuzzard_torrent_json",
            side_effect=run_wildbuzzard_torrent_json,
        ):
            root = pathlib.Path(directory)
            account = types.SimpleNamespace(
                pw_gid=os.getgid(), pw_uid=os.getuid(), pw_name="release-user"
            )
            browser_downloads = root / "browser-torrent-download"
            evidence = guest.validate_local_torrent_download(
                object(),
                root,
                account,
                {
                    "BUZZARD_TORRENT_DOWNLOADS": str(browser_downloads),
                    "HOME": str(root),
                },
                timeout=1,
            )
            self.assertEqual(evidence["downloadedSha256"], evidence["payloadSha256"])
            self.assertEqual(
                json.loads((root / "torrent-download-validation.json").read_text()),
                evidence,
            )

        by_label = {call["label"]: call for call in calls}
        added = by_label["wildbuzzard-torrent-add-local-fixture"]
        self.assertEqual(added["command"][0], "torrent-add")
        self.assertEqual(added["command"][1], "--file")
        self.assertTrue(added["command"][2].endswith(".torrent"))
        self.assertEqual(
            added["command"][3:],
            ["--download-path", str(pathlib.Path(directory) / "torrent-download")],
        )
        deleted = by_label["wildbuzzard-torrent-control-delete"]
        self.assertEqual(
            deleted["command"],
            [
                "torrent-control",
                "delete",
                info_hash,
                "--no-delete-data",
            ],
        )
        self.assertEqual(
            added["environment"]["BUZZARD_TORRENT_DOWNLOADS"],
            str(pathlib.Path(directory) / "browser-torrent-download"),
        )


class GUISessionTests(unittest.TestCase):
    def test_unlocks_sessions_and_uses_an_isolated_user_environment(self):
        runner = mock.Mock()
        account = types.SimpleNamespace(pw_name="release-user")
        environment = {
            "DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
            "HOME": "/home/release-user",
            "PATH": "/usr/bin:/bin",
            "XDG_RUNTIME_DIR": "/run/user/1000",
        }
        guest.prepare_gui_session(runner, account, environment)
        commands = [call.args[0] for call in runner.run.call_args_list]
        self.assertEqual(commands[0], ["/usr/bin/loginctl", "unlock-sessions"])
        self.assertTrue(
            all(command[4:6] == ["/usr/bin/env", "-i"] for command in commands[1:])
        )
        self.assertIn("org.gnome.ScreenSaver.SetActive", commands[-1])


class ExtensionProfileTests(unittest.TestCase):
    def test_finds_unique_profile_under_home_wildbuzzard(self):
        with temporary_directory() as directory:
            home = pathlib.Path(directory)
            profile = home / "WildBuzzard" / "Profiles" / "release.default"
            profile.mkdir(parents=True)
            mappings = {
                "web-search@extensions.wildbuzzard": "11111111-1111-4111-8111-111111111111",
                "torrent-search@extensions.wildbuzzard": "22222222-2222-4222-8222-222222222222",
            }
            addons = []
            for addon_id, slug in guest.EXPECTED_BUILTIN_ADDONS.items():
                addons.append({
                    "active": True,
                    "id": addon_id,
                    "location": "app-builtin-addons",
                    "rootURI": f"resource://builtin-addons/{slug}/",
                    "type": "extension",
                    "version": "0.1.0"
                    if addon_id in guest.ADDONS.values()
                    else "1.0.0",
                    "visible": True,
                })
            (profile / "extensions.json").write_text(
                json.dumps({"addons": addons}), encoding="utf-8"
            )
            encoded_mappings = json.dumps(json.dumps(mappings, separators=(",", ":")))
            (profile / "prefs.js").write_text(
                f'user_pref("extensions.webextensions.uuids", {encoded_mappings});\n',
                encoding="utf-8",
            )
            account = types.SimpleNamespace(pw_dir=str(home))
            result_dir = home / "results"
            evidence = guest.find_extension_profile(
                account, result_dir, {"HOME": str(home)}, timeout=0.1
            )
            self.assertEqual(evidence["profile"], str(profile))
            self.assertEqual(set(evidence["extensions"]), set(mappings))
            self.assertEqual(
                set(evidence["systemExtensions"]), set(guest.CORE_BUILTIN_ADDONS)
            )
            self.assertEqual(
                set(evidence["factoryExtensionIds"]),
                set(guest.EXPECTED_BUILTIN_ADDONS),
            )

            addons.append({
                "active": True,
                "id": "agent@extensions.wildbuzzard",
                "location": "app-builtin-addons",
                "rootURI": "resource://builtin-addons/agent/",
                "type": "extension",
                "version": "1.0.0",
                "visible": True,
            })
            (profile / "extensions.json").write_text(
                json.dumps({"addons": addons}), encoding="utf-8"
            )
            with self.assertRaises(RuntimeError):
                guest.find_extension_profile(
                    account, result_dir, {"HOME": str(home)}, timeout=0.01
                )

    def test_snapshot_ref_requires_one_exact_native_target(self):
        snapshot = {
            "details": {"refs": [{"name": "Search", "ref": "r1", "role": "button"}]}
        }
        self.assertEqual(guest.snapshot_ref(snapshot, "Search", ("button",)), "@r1")
        snapshot["details"]["refs"].append({
            "name": "Search",
            "ref": "r2",
            "role": "button",
        })
        with self.assertRaises(RuntimeError):
            guest.snapshot_ref(snapshot, "Search", ("button",))


class NativeExtensionUITests(unittest.TestCase):
    def test_opened_page_rejects_missing_or_nonpositive_page_ids(self):
        for value in (None, True, 0, -1, "1"):
            result = {} if value is None else {"details": {"page": value}}
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                guest.opened_page(result, "test")

    def test_uses_moz_extension_open_fill_and_click_without_evaluate(self):
        calls = []

        def browser_json(
            _runner, _result_dir, _account, _environment, _label, arguments, **_options
        ):
            calls.append(arguments)
            command = next(
                value
                for value in (
                    "open",
                    "wait",
                    "snapshot",
                    "fill",
                    "click",
                    "read",
                    "screenshot",
                )
                if value in arguments
            )
            if command == "open":
                return {"ok": True, "details": {"page": 17}}
            if command == "wait":
                return {"details": {"matched": True}}
            if command == "snapshot":
                return {
                    "details": {
                        "refs": [
                            {"name": "Search query", "ref": "query", "role": "textbox"},
                            {"name": "Search", "ref": "search", "role": "button"},
                        ]
                    }
                }
            if command == "read":
                return {"content": [{"type": "text", "text": "2 results\nitem"}]}
            return {"ok": True}

        extension_profile = {
            "extensions": {
                guest.ADDONS["web-search"]: {
                    "uuid": "11111111-1111-4111-8111-111111111111"
                }
            }
        }
        with temporary_directory() as directory, mock.patch.object(
            guest, "browser_json", side_effect=browser_json
        ), mock.patch.object(guest, "verify_png"):
            guest.validate_extension_ui(
                object(),
                pathlib.Path(directory),
                object(),
                {},
                extension_profile,
                slug="web-search",
                page="search/search.html",
                query="Debian Linux release",
                query_name="Search query",
                screenshot_name="web-search-extension.png",
            )
        flat = [value for arguments in calls for value in arguments]
        self.assertTrue(
            any(
                value
                == "moz-extension://11111111-1111-4111-8111-111111111111/search/search.html"
                for value in flat
            )
        )
        self.assertIn("fill", flat)
        self.assertIn("click", flat)
        self.assertNotIn("evaluate", flat)
        page_scoped = [
            arguments
            for arguments in calls
            if any(
                command in arguments
                for command in (
                    "wait",
                    "snapshot",
                    "fill",
                    "click",
                    "read",
                    "screenshot",
                )
            )
        ]
        self.assertTrue(page_scoped)
        for arguments in page_scoped:
            self.assertIn("--page", arguments)
            self.assertEqual(arguments[arguments.index("--page") + 1], "17")


class InstalledBrowserSurfaceTests(unittest.TestCase):
    def test_evaluate_page_is_explicitly_page_scoped(self):
        with mock.patch.object(
            guest,
            "browser_json",
            return_value={"details": {"value": {"ok": True}}},
        ) as browser_json:
            value = guest.evaluate_page(
                object(),
                pathlib.Path("/results"),
                object(),
                {},
                "label",
                "session",
                19,
                "return { ok: true };",
            )
        self.assertEqual(value, {"ok": True})
        arguments = browser_json.call_args.args[5]
        self.assertEqual(
            arguments,
            [
                "--session",
                "session",
                "evaluate",
                "--page",
                "19",
                "--code",
                "return { ok: true };",
            ],
        )

    def test_addons_manager_requires_exact_visible_extension_set(self):
        inventory = [
            {
                "id": "torrent-search@extensions.wildbuzzard",
                "name": "Torrent Search",
            },
            {
                "id": "web-search@extensions.wildbuzzard",
                "name": "Buzzard Web Search",
            },
        ]
        with mock.patch.object(
            guest,
            "browser_json",
            return_value={"ok": True, "details": {"page": 23}},
        ), mock.patch.object(guest, "wait_for_selector"), mock.patch.object(
            guest, "evaluate_page", return_value=inventory
        ), mock.patch.object(
            guest,
            "screenshot_page",
            return_value=pathlib.Path("/results/screenshots/extensions.png"),
        ):
            evidence = guest.validate_addons_manager(
                object(), pathlib.Path("/results"), object(), {}
            )
            self.assertEqual(evidence["extensions"], inventory)

        with mock.patch.object(
            guest,
            "browser_json",
            return_value={"ok": True, "details": {"page": 23}},
        ), mock.patch.object(guest, "wait_for_selector"), mock.patch.object(
            guest,
            "evaluate_page",
            return_value=inventory
            + [{"id": "webcompat@mozilla.org", "name": "Web Compatibility"}],
        ), mock.patch.object(guest, "screenshot_page"):
            with self.assertRaises(RuntimeError):
                guest.validate_addons_manager(
                    object(), pathlib.Path("/results"), object(), {}
                )

    def test_search_settings_require_duckduckgo_for_both_contexts(self):
        defaults = {
            "normal": {"id": "ddg-id", "label": "DuckDuckGo", "optionCount": 3},
            "private": {"id": "ddg-id", "label": "DuckDuckGo", "optionCount": 3},
        }
        with mock.patch.object(
            guest,
            "browser_json",
            return_value={"ok": True, "details": {"page": 29}},
        ), mock.patch.object(guest, "wait_for_selector"), mock.patch.object(
            guest, "evaluate_page", return_value=defaults
        ), mock.patch.object(
            guest,
            "screenshot_page",
            return_value=pathlib.Path("/results/screenshots/search-settings.png"),
        ):
            evidence = guest.validate_search_settings(
                object(), pathlib.Path("/results"), object(), {}
            )
            self.assertEqual(evidence["defaults"], defaults)

        changed = copy.deepcopy(defaults)
        changed["private"]["label"] = "Google"
        with mock.patch.object(
            guest,
            "browser_json",
            return_value={"ok": True, "details": {"page": 29}},
        ), mock.patch.object(guest, "wait_for_selector"), mock.patch.object(
            guest, "evaluate_page", return_value=changed
        ), mock.patch.object(guest, "screenshot_page"):
            with self.assertRaises(RuntimeError):
                guest.validate_search_settings(
                    object(), pathlib.Path("/results"), object(), {}
                )

    def test_tor_gate_requires_distinct_verified_egress_and_onion(self):
        calls = []

        def browser_json(
            _runner, _result_dir, _account, _environment, label, arguments, **_options
        ):
            calls.append(arguments)
            return {
                "ok": True,
                "details": {
                    "page": 41 if "direct" in label else 43,
                    "tor": "direct" not in label,
                },
            }

        def evaluate_page(
            _runner,
            _result_dir,
            _account,
            _environment,
            label,
            _session,
            _page,
            _code,
            **_options,
        ):
            if "direct" in label:
                return {"isTor": False, "ipSha256": "1" * 64}
            if "onion" in label:
                return {
                    "host": guest.TOR_ONION_HOST,
                    "protocol": "http:",
                    "textLength": 100,
                }
            return {"isTor": True, "ipSha256": "2" * 64}

        with mock.patch.object(
            guest, "browser_json", side_effect=browser_json
        ), mock.patch.object(
            guest, "evaluate_page", side_effect=evaluate_page
        ), mock.patch.object(
            guest,
            "screenshot_page",
            return_value=pathlib.Path("/results/screenshots/tor.png"),
        ):
            evidence = guest.validate_tor_egress(
                object(), pathlib.Path("/results"), object(), {}
            )
        self.assertTrue(evidence["torIsTor"])
        self.assertTrue(evidence["egressChanged"])
        tor_opens = [arguments for arguments in calls if "--tor" in arguments]
        self.assertEqual(len(tor_opens), 2)
        self.assertTrue(all("open" in arguments for arguments in tor_opens))


class EvidenceHelperTests(unittest.TestCase):
    def test_browser_torrent_fixture_serves_exact_metadata_and_magnet(self):
        fixture = guest.TorrentFixture(payload=b"browser-ingress-fixture")
        with fixture, guest.BrowserTorrentFixtureServer(fixture) as source:
            with urllib.request.urlopen(source["url"], timeout=2) as response:
                page = response.read().decode("utf-8")
                self.assertEqual(response.headers.get_content_type(), "text/html")
            torrent_url = urllib.parse.urljoin(source["url"], "/release.torrent")
            with urllib.request.urlopen(torrent_url, timeout=2) as response:
                self.assertEqual(
                    response.headers.get_content_type(), "application/x-bittorrent"
                )
                self.assertEqual(
                    response.headers.get("Content-Disposition"),
                    'attachment; filename="wildbuzzard-release-validation.torrent"',
                )
                self.assertEqual(response.read(), fixture.torrent)

        self.assertIn('id="torrent"', page)
        self.assertIn('id="magnet"', page)
        self.assertIn(f"urn:btih:{fixture.info_hash_hex}", source["magnet"])
        self.assertIn(
            urllib.parse.quote(fixture.announce_url, safe=""), source["magnet"]
        )

    def test_fixture_server_is_loopback_http_and_png_validation_is_strict(self):
        body = b"<!doctype html><title>fixture</title>"
        with guest.FixtureServer(body) as url:
            self.assertTrue(url.startswith("http://127.0.0.1:"))
            with urllib.request.urlopen(url, timeout=2) as response:
                self.assertEqual(response.read(), body)

        with temporary_directory() as directory:
            screenshot = pathlib.Path(directory) / "screenshot.png"
            screenshot.write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + b"\x00\x00\x00\x0dIHDR"
                + (1).to_bytes(4, "big") * 2
                + b"\x08\x06\x00\x00\x00"
                + b"\x00\x00\x00\x00"
                + b"\x00\x00\x00\x00IEND\xaeB`\x82"
            )
            guest.verify_png(screenshot, "test")
            valid_png = screenshot.read_bytes()
            screenshot.write_bytes(b"not a png")
            with self.assertRaises(RuntimeError):
                guest.verify_png(screenshot, "test")

            display = pathlib.Path(directory) / "display.png"
            display.write_bytes(valid_png)
            host.verify_png(display, "test")
            with self.assertRaises(RuntimeError):
                host.verify_png(display, "test", minimum_size=100)
            display.write_bytes(b"not a png")
            with self.assertRaises(RuntimeError):
                host.verify_png(display, "test")


if __name__ == "__main__":
    unittest.main()
