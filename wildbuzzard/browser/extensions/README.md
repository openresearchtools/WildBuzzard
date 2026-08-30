# Built-in search extensions

WildBuzzard stages the offline runtime of its web-search and torrent-search
extensions from the canonical sibling `wildbuzzard-extensions` repository. The
staged copies are browser-UI-only Firefox add-ons. They contain no search
engine or indexer implementation and never render provider JavaScript.

Their backends are ordinary, standalone apt-installed CLI executables with no
browser or web UI: `/usr/bin/buzzard-search` from `buzzard-search` and
`/usr/bin/buzzard-minijtt` from `buzzard-minijtt`. If either backend is absent,
its extension shows `sudo apt install buzzard-search` or
`sudo apt install buzzard-minijtt` respectively. `SOURCES.lock.json` records
this boundary alongside every source pin.

From the WildBuzzard repository, synchronize the default sibling checkouts:

```sh
python3 wildbuzzard/scripts/sync_builtin_search_extensions.py sync
```

For CI or a different checkout layout, pass `--extensions-source` or set
`WILDBUZZARD_EXTENSIONS_SOURCE`. The repository must contain
`extensions/web-search` and `extensions/torrent-search`.

Validate staged files against source checkouts with `check`. Use
`check --bundled-only` where the sibling repositories are intentionally absent.
`SOURCES.lock.json` pins both staged subtrees independently of their packaged
provenance. Normal browser builds run the bundled-only check before packaging
that lock, and the same policy is registered as a Python test for CI.
