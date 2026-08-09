# SPDX-License-Identifier: AGPL-3.0-or-later

import shutil


def main(output, source):
    with open(source, "rb") as source_file:
        shutil.copyfileobj(source_file, output)
