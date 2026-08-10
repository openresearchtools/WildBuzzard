<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Native web search and torrent discovery goal

The installed Codex harness keeps a goal objective inline only when the
materialized objective is at most 4,000 Unicode code points. A larger objective
is written to an ephemeral `goal-objective.md` attachment and replaced by a
short file-reference instruction. The durable specification therefore belongs
in the repository, while the goal remains deliberately short.

Use this objective:

> Implement WildBuzzard native web search, Gecko extraction/crawling, and
> torrent discovery exactly as specified in
> `/home/user/Downloads/WildBuzzard/wildbuzzard/WEB-SEARCH-TORRENT-PORT-SPEC.md`.
> Read that entire document first and treat it as the source of truth. Act as
> root orchestrator; use at most three isolated-worktree `gpt-5.6-sol`
> subagents concurrently at the high/ultra levels assigned by the spec. Do not
> stop at planning or mocks. Implement every phase, preserve license/process
> boundaries. Build and run every WildBuzzard component, bundled runtime,
> Firefox test, and AppImage directly on the host. Containers are disposable
> pristine-upstream parity oracles only and are never a product builder,
> runtime, package stage, or user dependency. First reproduce and fix the
> existing Add Torrent/File
> native-chooser JavaScript failure, with an automated privileged-picker test
> and headed built-browser/AppImage E2E. Ship the constrained GPL-2.0-only
> Jackett Mini with an immutable catalog enabling every credential-free,
> non-adult-only, non-external-solver public source; include mixed/general
> sources but permanently filter adult result categories. Expose no dashboard,
> tracker credentials, raw upstream API, or provider/config mutation, and keep
> its internal capability token distinct from tracker credentials. Have root
> or root-owned ultra subagents provision exact pinned pristine SearXNG and
> Jackett services in rootless Podman or another rootless OCI runtime from
> authoritative immutable image digests or pinned upstream source builds. Run
> the same scenarios through each service's actual API, preserving the
> explicit original-to-ported request mapping, both raw transcripts,
> normalized diffs, logs, image/source digests, and live no-key source reports.
> Make torrent results a semantic table with Title, Size, Seeders, Leechers,
> Source/Category, and Download, defaulting to Seeders descending unless the
> user chooses another sort. Agent searches omitting sort also use Seeders
> descending with nulls last and never inherit UI sort state. Run all mandatory
> security, lifecycle, browser, agent, torrent, and AppImage tests, fix failures
> at the contract layer, build outside the source checkout, review and commit
> the complete source stack, push normally, open the final build, and report
> exact commits, artifacts, checksums, tests, and any genuinely blocked gate.
