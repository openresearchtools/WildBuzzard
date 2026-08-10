# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import shutil
import tempfile
from pathlib import Path

MAX_RUNTIME_ARCHIVE_SIZE = 1024 * 1024 * 1024


def validator():
    path = Path(__file__).parent / "scripts" / "validate-host-native-runtime-archive.py"
    spec = importlib.util.spec_from_file_location("host_native_runtime_validator", path)
    if spec is None or spec.loader is None:
        raise ValueError("Host-native runtime validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(output, source, kind, lock_path=None):
    root = Path(__file__).parent
    if kind not in ("torrent", "jackett-mini"):
        raise ValueError("Unsupported host-native runtime kind")
    lock_name = (
        "torrent-runtime-lock.json"
        if kind == "torrent"
        else "jackett-mini-runtime-lock.json"
    )
    validator_kind = "torrent" if kind == "torrent" else "jackett"
    with open(source, "rb") as source_file, tempfile.TemporaryFile() as snapshot:
        size = 0
        while chunk := source_file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_RUNTIME_ARCHIVE_SIZE:
                raise ValueError(
                    "Host-native runtime archive exceeds the packaging limit"
                )
            snapshot.write(chunk)
        snapshot.seek(0)
        validator().validate_opened_archive(
            snapshot,
            Path(lock_path) if lock_path else root / lock_name,
            validator_kind,
        )
        snapshot.seek(0)
        shutil.copyfileobj(snapshot, output)
