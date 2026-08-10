# SPDX-License-Identifier: AGPL-3.0-or-later

import unicodedata

SCENARIOS = {
    "acquisition-url-reuse",
    "adult-category-matrix",
    "adult-provider-generic-8000",
    "cache-bypass-first",
    "cache-bypass-second",
    "cache-expired",
    "cache-first",
    "cache-hit",
    "contradictory-peer-client-guard",
    "custom-category",
    "duplicate-infohash-alternates",
    "error-code-200-source-contract",
    "external-entity-network",
    "hanging-provider-timeout",
    "http-429-retry-after",
    "invalid-apikey",
    "invalid-imdb-parameter",
    "malicious-fields",
    "missing-apikey",
    "missing-category",
    "mixed-safe-adult-category",
    "omitted-indexer-route",
    "partial-success",
    "peer-counts",
    "redirect-loop",
    "redirect-once",
    "stale-generation",
    "tracker-deep-xml",
    "tracker-entity-xml",
    "tracker-malformed-xml",
    "tracker-oversized-xml",
    "tracker-tls-failure",
    "unavailable-indexers-mode",
    "unavailable-tmdb-function",
    "unsupported-indexer",
    "unsupported-mode",
    "valid-apikey",
    "valid-passkey-alias",
}


def response(**values):
    return {
        "outcome": "response",
        "status": 200,
        "contentType": "application/json",
        **values,
    }


def empty(status):
    return {
        "outcome": "response",
        "status": status,
        "contentType": None,
        "root": "non-json",
    }


def invalid():
    return response(status=400, error="invalid-request")


def clean(value):
    return "".join(
        character
        for character in unicodedata.normalize("NFC", value)
        if not unicodedata.category(character).startswith("C")
    )[:512]


def mapped_item(item, provider=None):
    return {
        "title": clean(item["title"]),
        "indexerId": provider
        or {"oracle-main": "main", "oracle-alternate": "alternate"}.get(
            item.get("indexerId"), item.get("indexerId")
        ),
        "categoryIds": item["categoryIds"],
        "seeders": item["seeders"],
        "normalizedLeechers": item["normalizedLeechers"],
        "acquisition": "magnet" if item.get("infoHash") else "torrent",
    }


def search(pristine, providers=("main",), items=None, partial=False):
    if items is None:
        items = [mapped_item(item) for item in pristine.get("items", [])]
    return response(
        partial=partial,
        providers=[{"id": provider, "state": "ok"} for provider in providers],
        items=sorted(items, key=lambda item: (item["indexerId"], item["title"])),
    )


def provider_error(provider="main"):
    return response(
        partial=True,
        providers=[{"id": provider, "state": "error"}],
        items=[],
    )


def expected_for(name, pristine, all_pristine):
    if name in {"valid-apikey", "unavailable-indexers-mode"}:
        return response(
            sources=[
                {"id": "alternate", "state": "ready"},
                {"id": "main", "state": "ready"},
            ]
        )
    if name == "valid-passkey-alias":
        return empty(400)
    if name in {"missing-apikey", "invalid-apikey"}:
        return empty(401)
    if name in {
        "unsupported-indexer",
        "unsupported-mode",
        "unavailable-tmdb-function",
        "invalid-imdb-parameter",
        "adult-provider-generic-8000",
    }:
        return invalid()
    if name == "omitted-indexer-route":
        items = [
            {
                "title": f"Fixture mini-{provider}",
                "indexerId": provider,
                "categoryIds": [2000, 112735],
                "seeders": 4,
                "normalizedLeechers": 2,
                "acquisition": "magnet",
            }
            for provider in ("alternate", "main")
        ]
        return search({}, ("alternate", "main"), items)
    if name in {
        "tracker-malformed-xml",
        "tracker-deep-xml",
        "tracker-entity-xml",
        "tracker-oversized-xml",
        "tracker-tls-failure",
        "redirect-loop",
        "http-429-retry-after",
    }:
        return provider_error()
    if name == "hanging-provider-timeout":
        return {"outcome": "timeout"}
    if name in {"adult-category-matrix", "mixed-safe-adult-category"}:
        return search({}, items=[])
    if name in {
        "missing-category",
        "redirect-once",
        "peer-counts",
        "custom-category",
        "malicious-fields",
    }:
        return search(pristine)
    if name == "duplicate-infohash-alternates":
        main = next(
            item for item in pristine["items"] if item["indexerId"] == "oracle-main"
        )
        return search({}, ("main", "alternate"), [mapped_item(main)])
    if name == "partial-success":
        main = next(
            item for item in pristine["items"] if item["indexerId"] == "oracle-main"
        )
        value = search({}, items=[mapped_item(main)], partial=True)
        value["providers"] = [
            {"id": "alternate", "state": "error"},
            {"id": "main", "state": "ok"},
        ]
        return value
    if name in {
        "cache-first",
        "cache-hit",
        "cache-expired",
        "cache-bypass-first",
        "cache-bypass-second",
    }:
        value = search(all_pristine["cache-first"])
        if name == "cache-hit":
            value["fixtureRequests"] = 1
        elif name == "cache-expired":
            value["fixtureRequests"] = 1
        elif name == "cache-bypass-second":
            value["fixtureRequests"] = 0
        return value
    if name == "stale-generation":
        return {
            "completionOrder": ["fast", "slow"],
            "fast": search(pristine["fast"]),
            "slow": search(pristine["slow"]),
        }
    if name == "acquisition-url-reuse":
        return {
            "first": response(resolution={"kind": "magnet", "torrentBytes": None}),
            "second": response(status=404, error="unknown-or-expired-result"),
            "oneShot": True,
        }
    if name == "contradictory-peer-client-guard":
        return {"seeders": 10, "normalizedLeechers": 0}
    if name == "external-entity-network":
        return {
            "requests": 0,
            "providerResponse": provider_error(),
        }
    if name == "error-code-200-source-contract":
        return response(status=404, error="not-found")
    raise AssertionError(f"no explicit Mini semantic transform for {name}")


def validate_all(pristine, mini):
    if set(pristine) != SCENARIOS or set(mini) != SCENARIOS:
        raise AssertionError(
            "the adversarial scenario set differs from the reviewed Mini transforms"
        )
    differences = {}
    for name in sorted(SCENARIOS):
        expected = expected_for(name, pristine[name], pristine)
        if mini[name] != expected:
            differences[name] = {"expected": expected, "actual": mini[name]}
    if differences:
        raise AssertionError(f"unexplained Mini semantic differences: {differences}")
