# SPDX-License-Identifier: AGPL-3.0-or-later

import concurrent.futures
import json
import os
import pathlib
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


@unittest.skipUnless(sys.platform == "linux", "Linux native command transport")
class NativeCommandLineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory(prefix="wbc-build-")
        cls.addClassCleanup(cls.build.cleanup)
        root = pathlib.Path(cls.build.name)
        main = root / "main.cpp"
        main.write_text(
            '#include "WildBuzzardCommandLine.h"\n'
            "#include <stdio.h>\n#include <stdlib.h>\n#include <unistd.h>\n"
            "int main(int argc, char** argv) {\n"
            "  int code;\n"
            "  if (HandleWildBuzzardCommandLine(argc, argv, code)) return code;\n"
            '  const char* fixture = getenv("WB_TEST_BROWSER");\n'
            "  if (argc == 1 && fixture) {\n"
            "    execl(fixture, fixture, nullptr);\n"
            "    return 1;\n"
            "  }\n"
            "  for (int i = 1; i < argc; ++i) puts(argv[i]);\n"
            "  return 42;\n}\n",
            encoding="utf-8",
        )
        cls.binary = root / "wildbuzzard"
        jsoncpp = ROOT / "toolkit/components/jsoncpp"
        compiler = os.environ.get("CXX") or shutil.which("c++")
        if not compiler:
            raise unittest.SkipTest("A C++ compiler is required")
        result = subprocess.run(
            [
                *shlex.split(compiler),
                "-std=c++17",
                "-pthread",
                "-DJSON_USE_EXCEPTION=0",
                "-fno-exceptions",
                "-I",
                str(ROOT / "browser/app"),
                "-I",
                str(jsoncpp / "include"),
                str(main),
                str(ROOT / "browser/app/WildBuzzardCommandLine.cpp"),
                *[
                    str(jsoncpp / "src/lib_json" / name)
                    for name in ("json_reader.cpp", "json_value.cpp", "json_writer.cpp")
                ],
                "-o",
                str(cls.binary),
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="wbc-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.env = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith(("WILDBUZZARD_", "WB_TEST_", "XDG_"))
        }
        self.env.update(HOME=str(self.root), XDG_RUNTIME_DIR=str(self.root))
        self.socket_path = self.root / "control.sock"
        self.env["WILDBUZZARD_CONTROL_SOCKET"] = str(self.socket_path)

    def call(self, *arguments, input=None, binary=None):
        return subprocess.run(
            [str(binary or self.binary), *arguments],
            env=self.env,
            cwd=self.root,
            input=input,
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )

    def listen(self, path=None):
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(str(path or self.socket_path))
        os.chmod(path or self.socket_path, 0o600)
        listener.listen(16)
        listener.settimeout(5)
        return listener

    def exchange(self, arguments, response=None, input=None):
        listener = self.listen()
        received = []

        def serve():
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(5)
                data = b""
                while b"\n" not in data:
                    block = connection.recv(8192)
                    if not block:
                        raise AssertionError("command connection closed early")
                    data += block
                received.append(json.loads(data))
                payload = response
                if payload is None:
                    payload = (
                        json.dumps({
                            "exitCode": 0,
                            "stdout": json.dumps(received[0]),
                            "stderr": "",
                        }).encode()
                        + b"\n"
                    )
                for offset in range(0, len(payload), 7):
                    connection.sendall(payload[offset : offset + 7])

        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(serve)
            result = self.call(*arguments, input=input)
            future.result(timeout=5)
        self.socket_path.unlink()
        return result, received[0]

    def test_all_catalog_tools_and_aliases_reach_gecko(self):
        source = (
            ROOT / "browser/components/wildbuzzardcontrol/WildBuzzardCommand.sys.mjs"
        ).read_text()
        catalog = source.split("const TOOL_INFO = [", 1)[1].split(
            "const TOOL_NAMES", 1
        )[0]
        commands = set(re.findall(r'\[\s*"([a-z_]+)"', catalog))
        commands.update({
            "help",
            "h",
            "version",
            "tools",
            "skill",
            "status",
            "open",
            "devtools",
            "console",
            "network",
            "request",
            "debugger",
            "scripts",
            "script_source",
            "logpoint_set",
            "logpoint_remove",
            "logpoint_results",
            "render",
            "back",
            "forward",
            "reload",
            "click",
            "click_at",
            "type",
            "type_at",
            "fill",
            "press",
            "hover",
            "hover_at",
            "focus",
            "check",
            "uncheck",
            "select",
            "scroll",
            "drag",
            "drag_at",
            "dialog_accept",
            "dialog_dismiss",
        })
        for command in sorted(commands):
            for spelling in {command, command.replace("_", "-")}:
                with self.subTest(command=spelling):
                    result, request = self.exchange([
                        "--session",
                        "agent-one",
                        "--no-start",
                        "--json",
                        spelling,
                    ])
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(request["argv"][-1], spelling)
                    self.assertEqual(request["version"], 1)
                    self.assertEqual(request["cwd"], str(self.root))

    def test_refs_unicode_stdin_and_exit_status_are_preserved(self):
        arguments = ["--session=agent-two", "click", "@e4", "--input", "-"]
        output = "clicked e4: café 漢字\n"
        response = (
            json.dumps(
                {"exitCode": 17, "stdout": output, "stderr": "notice\n"},
                ensure_ascii=False,
            ).encode()
            + b"\n"
        )
        result, request = self.exchange(arguments, response, input='{"value":"é"}')
        self.assertEqual(request["argv"], arguments)
        self.assertEqual(request["stdin"], '{"value":"é"}')
        self.assertEqual(
            (result.returncode, result.stdout, result.stderr), (17, output, "notice\n")
        )

    def test_normal_browser_arguments_are_untouched(self):
        for arguments in [
            [],
            ["https://example.com"],
            ["--headless", "--profile", "/tmp/profile"],
            ["--version"],
            ["--contentproc", "42"],
        ]:
            with self.subTest(arguments=arguments):
                result = self.call(*arguments)
                self.assertEqual(result.returncode, 42)
                self.assertEqual(result.stdout.splitlines(), arguments)

    def test_no_start_reports_status_and_errors_as_json(self):
        result = self.call("status", "--no-start", "--json")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(json.loads(result.stdout)["running"])
        result = self.call("snapshot", "--no-start", "--json")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            json.loads(result.stderr),
            {"ok": False, "error": "Wild Buzzard is not running"},
        )

    def test_no_start_environment_includes_empty_values(self):
        for value in ["", "1"]:
            with self.subTest(value=value):
                self.env["WILDBUZZARD_NO_START"] = value
                result = self.call("status", "--json")
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertFalse(json.loads(result.stdout)["running"])

    def test_discovers_one_profile_and_rejects_ambiguity(self):
        del self.env["WILDBUZZARD_CONTROL_SOCKET"]
        directory = self.root / "wildbuzzard/profiles"
        directory.mkdir(parents=True, mode=0o700)
        paths = [
            directory / f"control-{'a' * 24}-{letter * 12}.sock" for letter in "AB"
        ]
        first = self.listen(paths[0])
        second = self.listen(paths[1])
        result = self.call("snapshot", "--no-start", "--json")
        self.assertIn(
            "multiple Wild Buzzard profiles", json.loads(result.stderr)["error"]
        )
        for path in paths:
            self.assertIn(str(path), result.stderr)
        first.close()
        second.close()
        self.socket_path = paths[0]
        paths[0].unlink()
        result, _ = self.exchange(["snapshot", "--no-start"])
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_unsafe_socket_overrides(self):
        for path in [
            "relative.sock",
            str(self.root / ".." / "control.sock"),
            str(self.root) + "/x\n.sock",
            "/" + "x" * 110,
        ]:
            with self.subTest(path=path):
                self.env["WILDBUZZARD_CONTROL_SOCKET"] = path
                result = self.call("snapshot", "--no-start", "--json")
                self.assertEqual(result.returncode, 1)
                self.assertFalse(json.loads(result.stderr)["ok"])

    def test_rejects_shared_and_symlink_socket_paths(self):
        listener = self.listen()
        self.socket_path.chmod(0o666)
        self.assertIn("private", self.call("snapshot", "--no-start").stderr)
        listener.close()
        self.socket_path.unlink()
        real = self.root / "real.sock"
        self.listen(real)
        self.socket_path.symlink_to(real)
        self.assertIn("private", self.call("snapshot", "--no-start").stderr)

    def test_malformed_response_is_an_error(self):
        for response in [
            b"{}\n",
            b"[]\n",
            b"not json\n",
            b'{"exitCode":256,"stdout":"","stderr":""}\n',
        ]:
            with self.subTest(response=response):
                result, _ = self.exchange(
                    ["snapshot", "--no-start", "--json"], response
                )
                self.assertEqual(result.returncode, 1)
                self.assertEqual(
                    json.loads(result.stderr)["error"],
                    "invalid response from Wild Buzzard",
                )

    def test_auto_start_executes_the_same_binary(self):
        fixture = self.root / "browser"
        fixture.write_text(
            f"#!{sys.executable}\n"
            "import json, os, socket\n"
            "with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:\n"
            "    server.bind(os.environ['WILDBUZZARD_CONTROL_SOCKET'])\n"
            "    os.chmod(os.environ['WILDBUZZARD_CONTROL_SOCKET'], 0o600)\n"
            "    server.listen()\n"
            "    server.settimeout(5)\n"
            "    connection, _ = server.accept()\n"
            "    with connection:\n"
            "        request = connection.makefile('rb').readline()\n"
            "        connection.sendall(json.dumps({'exitCode': 0, 'stdout': 'started\\n', 'stderr': ''}).encode() + b'\\n')\n",
            encoding="utf-8",
        )
        fixture.chmod(0o700)
        self.env["WB_TEST_BROWSER"] = str(fixture)
        self.env["WILDBUZZARD_BROWSER_BINARY"] = "/does/not/exist"
        link = self.root / "wildbuzzard"
        link.symlink_to(self.binary)
        result = self.call("snapshot", binary=link)
        self.assertEqual(
            (result.returncode, result.stdout), (0, "started\n"), result.stderr
        )


if __name__ == "__main__":
    unittest.main()
