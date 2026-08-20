#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import hashlib
import json
from pathlib import Path


PRODUCT_SUFFIXES = {".ts", ".html", ".json", ".svg", ".webmanifest"}
PI_PACKAGES = (
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
)
COMMAND_FILES = (
    "extensions/pi-web.ts",
    "src/pluginRecoveryCli.ts",
    "src/shared/pluginRecoveryCommands.ts",
    "src/server/diagnostics/nodePtySpawnHelper.ts",
    "src/server/diagnostics/nodePtyNativeModule.ts",
    "src/client/src/components/settings/SettingsSessiondPanel.ts",
)


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def replace(path: Path, old: str, new: str, minimum: int = 1) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count < minimum:
        raise ValueError(f"missing downstream replacement in {path}: {old}")
    path.write_text(text.replace(old, new), encoding="utf-8")


def prepare(root: Path, lock_path: Path) -> None:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    pi_web = lock["piWeb"]
    expected = {
        "package.json": pi_web["packageJsonSha256"],
        "package-lock.json": pi_web["packageLockSha256"],
        "LICENSE": pi_web["licenseSha256"],
    }
    for name, sha256 in expected.items():
        if digest(root / name) != sha256:
            raise ValueError(f"pinned Pi Web input differs: {name}")

    package_path = root / "package.json"
    package = json.loads(package_path.read_text(encoding="utf-8"))
    package_lock_path = root / "package-lock.json"
    package_lock = json.loads(package_lock_path.read_text(encoding="utf-8"))
    if package["name"] != pi_web["name"] or package["version"] != pi_web["version"]:
        raise ValueError("pinned Pi Web package identity differs")
    if package_lock.get("lockfileVersion") != 3:
        raise ValueError("Pi Web requires npm lockfile version 3")

    lock_root = package_lock["packages"][""]
    for name in PI_PACKAGES:
        version = lock["piPackages"][name]
        if package["devDependencies"].get(name) != f"^{version}":
            raise ValueError(f"unexpected Pi SDK pin: {name}")
        package.setdefault("dependencies", {})[name] = version
        package["devDependencies"].pop(name)
        lock_root.setdefault("dependencies", {})[name] = version
        lock_root["devDependencies"].pop(name)
    write_json(package_path, package)
    write_json(package_lock_path, package_lock)

    for directory in (root / "src", root / "extensions", root / "pi-web-plugins"):
        for path in sorted(directory.rglob("*")):
            if not path.is_file() or path.suffix not in PRODUCT_SUFFIXES:
                continue
            text = path.read_text(encoding="utf-8")
            text = text.replace("PI WEB", "Buzzard Agent Web")
            text = text.replace("Pi Web", "Buzzard Agent Web")
            path.write_text(text, encoding="utf-8")

    for relative in COMMAND_FILES:
        path = root / relative
        text = path.read_text(encoding="utf-8")
        if "pi-web" not in text:
            raise ValueError(f"missing upstream command labels in {relative}")
        path.write_text(text.replace("pi-web", "buzzard-agent-web"), encoding="utf-8")

    status_path = root / "src/server/piWebStatus.ts"
    replace(
        status_path,
        '''async function piWebCliCommands(installation: PiWebInstallationInfo | undefined): Promise<NativeServiceCommands> {
  if (installation?.kind !== "npm-global" || !(await hasCommand("pi-web"))) return {};
  return { restart: "pi-web restart", status: "pi-web status" };
}''',
        '''async function piWebCliCommands(_installation: PiWebInstallationInfo | undefined): Promise<NativeServiceCommands> {
  if (!(await hasCommand("buzzard-agent-web"))) return {};
  return { restart: "buzzard-agent-web restart", status: "buzzard-agent-web status" };
}''',
    )
    replace(
        status_path,
        'const PI_WEB_PACKAGE_NAME = "@jmfederico/pi-web";',
        'const PI_WEB_PACKAGE_NAME = "buzzard-agent-web";',
    )
    updates_path = root / "pi-web-plugins/updates/updatesLogic.ts"
    replace(updates_path, '"@jmfederico/pi-web"', '"buzzard-agent-web"', minimum=2)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("lock", type=Path)
    arguments = parser.parse_args()
    prepare(arguments.source.resolve(), arguments.lock.resolve())


if __name__ == "__main__":
    main()
