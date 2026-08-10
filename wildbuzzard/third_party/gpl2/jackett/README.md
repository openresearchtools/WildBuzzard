<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Jackett Mini source package

This directory contains the complete pinned Jackett v0.24.2360 source archive, a deterministic downstream patch series, locked NuGet dependency graphs, an exhaustive immutable provider review, build inputs, and third-party notices for the standalone Jackett Mini process.

Build Linux glibc x86-64 from outside the source checkout:

```sh
wildbuzzard/scripts/build-jackett-mini.sh \
  --output /absolute/path/to/jackett-mini-runtime \
  --archive /absolute/path/to/wildbuzzard-jackett-mini-runtime.zip \
  --object-dir /absolute/path/to/empty-build-directory \
  --log-dir /absolute/path/to/build-logs
```

The build verifies all 963 pristine source files, applies `patches/series`, checks all 616 effective providers against their reviewed source hashes, stages only eligible YAML, performs a locked self-contained .NET 9 publish in rootless Podman, and rejects forbidden runtime paths. A deterministic process-boundary gate also scans the non-GPL browser, agent, launcher, and torrent runtime for Jackett assembly/namespace references, CLR hosting, copied upstream surfaces, and direct GPL package paths. The deterministic ZIP contains its exact manifest, SPDX SBOM, license inventory, and complete corresponding-source package.

Podman and the SDK image are build/test infrastructure. Neither is used by the shipped runtime. The runtime executable accepts the mandatory private launch flags documented in `BOUNDARY.md`; the capability is read from a mode-0600 file rather than a command-line value.
