#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
from pathlib import Path

PLACEHOLDER = "__WILDBUZZARD_FIXTURE_ORIGIN__"
ALLOWED_ORIGINS = {"", "http://127.0.0.1:18080"}


def bind_fixture_origin(source, origin):
    if origin not in ALLOWED_ORIGINS:
        raise ValueError("fixture origin is not the reviewed deterministic endpoint")
    value = source.read_text(encoding="utf-8")
    if value.count(PLACEHOLDER) != 1:
        raise ValueError("fixture origin placeholder is missing or duplicated")
    source.write_text(value.replace(PLACEHOLDER, origin), encoding="utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--origin", default="")
    args = parser.parse_args()
    bind_fixture_origin(args.source, args.origin)


if __name__ == "__main__":
    main()
