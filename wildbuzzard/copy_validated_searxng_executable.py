# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
from pathlib import Path


def validator():
    path = Path(__file__).parent / "scripts" / "validate-searxng-executable.py"
    spec = importlib.util.spec_from_file_location("searxng_executable_validator", path)
    if spec is None or spec.loader is None:
        raise ValueError("SearXNG executable validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(output, source, lock_path=None):
    root = Path(__file__).parent
    destination = Path(output.name)
    output.avoid_writing_to_file()
    output.close()
    validator().validate_and_copy(
        source,
        destination,
        Path(lock_path)
        if lock_path
        else root
        / "third_party"
        / "agpl"
        / "searxng"
        / "executable-artifact.lock.json",
    )
