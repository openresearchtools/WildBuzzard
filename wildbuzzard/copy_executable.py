# SPDX-License-Identifier: AGPL-3.0-or-later

import shutil
from pathlib import Path


def main(output, source):
    destination = Path(output.name)
    output.avoid_writing_to_file()
    output.close()
    shutil.copyfile(source, destination)
    destination.chmod(0o755)
