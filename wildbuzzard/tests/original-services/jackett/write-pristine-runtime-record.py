#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-or-later

import argparse
import pathlib

from pristine_runtime import write_build_record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--sdk-image-inspect", required=True, type=pathlib.Path)
    args = parser.parse_args()
    write_build_record(args.runtime, args.output, args.sdk_image_inspect)


if __name__ == "__main__":
    main()
