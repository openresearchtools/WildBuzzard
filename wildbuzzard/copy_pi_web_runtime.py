# SPDX-License-Identifier: AGPL-3.0-or-later

import importlib.util
import shutil
from pathlib import Path


def validator():
    path = Path(__file__).parent / "scripts" / "validate-pi-web-runtime-archive.py"
    spec = importlib.util.spec_from_file_location("pi_web_runtime_validator", path)
    if spec is None or spec.loader is None:
        raise ValueError("Pi Web runtime validator is unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(output, source):
    root = Path(__file__).parent
    validator().validate(Path(source), root / "pi-web-runtime-lock.json")
    with open(source, "rb") as source_file:
        shutil.copyfileobj(source_file, output)
