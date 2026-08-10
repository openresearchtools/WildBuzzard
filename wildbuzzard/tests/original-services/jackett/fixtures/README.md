<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Deterministic Jackett fixture

`fixture-indexer.yml.in` is rendered twice by the comparison runner. Pristine Jackett receives a custom test definition named `wildbuzzard-fixture`; a test-only Jackett Mini catalog overlay replaces the already eligible `showrss` definition with the same tracker logic. Neither overlay is part of a shipping runtime.

The local tracker returns ordinary magnet and torrent rows plus category-6000 rows. The runner compares pristine Torznab XML with Jackett Mini JSON after applying the documented product transformations.

`adversarial-indexer.yml.in` and `pristine-adversarial-expected.json` drive the side-by-side adversarial comparison. They cover the pinned original service's error, transport, XML, category, cache, peer-count, duplicate, partial-result, and malicious-field behavior. The runner renders the same definition into a disposable two-source Mini runtime overlay; neither fixture enters a shipping runtime.
