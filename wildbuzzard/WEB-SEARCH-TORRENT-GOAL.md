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
> boundaries, run pristine-versus-port parity and all mandatory security,
> lifecycle, browser, agent, torrent, and AppImage tests, fix failures at the
> contract layer, build outside the source checkout, review and commit the
> complete source stack, push normally, open the final build, and report exact
> commits, artifacts, checksums, tests, and any genuinely blocked gate.
