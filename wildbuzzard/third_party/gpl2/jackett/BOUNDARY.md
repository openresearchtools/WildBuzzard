<!-- SPDX-License-Identifier: GPL-2.0-only -->

# Jackett Mini license and process boundary

Everything in this directory is distributed as a separate GPL-2.0-only source package. The source archive is pristine Jackett; the patch series, catalog tooling, packaging scripts, and generated policy are downstream GPL-2.0-only material.

The WildBuzzard browser must communicate with the independently launched `jackett-mini` executable only through the authenticated JSON protocol. Browser code must not reference a `Jackett.*` assembly, load the CLR, copy Jackett DTOs or assets, or share an address space or dependency graph with this package.

The process accepts only `GET /v1/health`, `GET /v1/version`, `GET /v1/sources`, `POST /v1/search`, and `POST /v1/results/:opaque-result-id/resolve`. Every route requires the per-start capability in an `Authorization: Bearer` header. The runtime has no dashboard, updater, raw Torznab route, custom-definition path, provider mutation, provider credentials, permissive CORS, or public listener.

The shipping build stages only definitions classified `enabled-public`. It conditionally compiles only reviewed public native providers, omits the upstream dashboard content and FlareSolverr client, and rejects any catalog/source hash drift. The complete unmodified source remains in `upstream/`, so omitted runtime features remain available as corresponding source without becoming reachable product features.

Aggregate AppImage distribution requires legal review. This document records the technical boundary and is not legal advice.
