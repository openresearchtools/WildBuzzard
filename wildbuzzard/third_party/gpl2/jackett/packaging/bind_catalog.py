#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-only

import argparse
import hashlib
from pathlib import Path

PLACEHOLDER = "__WILDBUZZARD_CATALOG_SHA256__"


def bind_catalog(source, catalog):
    digest = hashlib.sha256(catalog.read_bytes()).hexdigest()
    value = source.read_text(encoding="utf-8")
    if value.count(PLACEHOLDER) != 1:
        raise ValueError("catalog binding placeholder is missing or duplicated")
    source.write_text(value.replace(PLACEHOLDER, digest), encoding="utf-8")
    return digest


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--catalog", required=True, type=Path)
    args = parser.parse_args()
    print(bind_catalog(args.source, args.catalog))


if __name__ == "__main__":
    main()
