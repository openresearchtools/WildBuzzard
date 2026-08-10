<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Packaging inputs

The package is built from the pristine archive plus `../patches/series`. Locked NuGet package versions and content hashes are added by the patch. `nuget-licenses.json` freezes the matching license audit. `write_runtime_metadata.py` writes the per-file runtime manifest and SPDX 2.3 inventory after a successful publish.

The build target is Linux glibc x86-64 only. A different architecture, musl, SDK image, package lock, provider hash, or source commit requires a separately reviewed build and manifest.
