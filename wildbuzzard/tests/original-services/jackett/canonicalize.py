# SPDX-License-Identifier: AGPL-3.0-or-later

import base64
import datetime
import email.utils
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET

MAX_XML_BYTES = 4 * 1024 * 1024
MAX_ELEMENTS = 20_000
MAX_DEPTH = 32
MAX_ATTRIBUTES = 100_000
MAX_TEXT = 8 * 1024 * 1024
MAX_RESULTS = 1_000
TORZNAB_ATTRIBUTE_NAMESPACES = (
    "http://torznab.com/schemas/2015/feed",
    "http://www.newznab.com/DTD/2010/feeds/attributes/",
)
BTIH_PATTERN = re.compile(r"^(?:[A-Fa-f0-9]{40}|[A-Za-z2-7]{32})$")


class TorznabError(ValueError):
    pass


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _validate_tree(root):
    element_count = 0
    attribute_count = 0
    text_count = 0
    stack = [(root, 1)]
    while stack:
        element, depth = stack.pop()
        if depth > MAX_DEPTH:
            raise TorznabError("XML depth limit exceeded")
        element_count += 1
        attribute_count += len(element.attrib)
        text_count += len(element.text or "") + len(element.tail or "")
        if element_count > MAX_ELEMENTS:
            raise TorznabError("XML element limit exceeded")
        if attribute_count > MAX_ATTRIBUTES:
            raise TorznabError("XML attribute limit exceeded")
        if text_count > MAX_TEXT:
            raise TorznabError("XML text limit exceeded")
        stack.extend((child, depth + 1) for child in element)


def parse_xml(payload):
    if not payload or len(payload) > MAX_XML_BYTES:
        raise TorznabError("XML byte limit exceeded")
    upper_payload = payload.upper()
    if b"<!DOCTYPE" in upper_payload or b"<!ENTITY" in upper_payload:
        raise TorznabError("DTD and entity declarations are forbidden")
    try:
        root = ET.fromstring(payload)
    except ET.ParseError as error:
        raise TorznabError("Malformed XML") from error
    _validate_tree(root)
    return root


def _child_text(element, name):
    for child in element:
        if _local_name(child.tag) == name:
            return (child.text or "").strip()
    return ""


def _attributes(item):
    values = {}
    for child in item:
        if _local_name(child.tag) != "attr":
            continue
        namespace = child.tag[1:].split("}", 1)[0] if child.tag.startswith("{") else ""
        if namespace and namespace not in TORZNAB_ATTRIBUTE_NAMESPACES:
            continue
        name = child.attrib.get("name", "").lower()
        if name:
            values.setdefault(name, []).append(child.attrib.get("value", ""))
    return values


def _integer(value):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed >= 0 else None


def _published(value):
    if not value:
        return None
    try:
        parsed = email.utils.parsedate_to_datetime(value)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def _infohash(attributes):
    candidates = list(attributes.get("infohash", []))
    candidates.extend(attributes.get("magneturl", []))
    for candidate in candidates:
        if BTIH_PATTERN.fullmatch(candidate):
            return candidate.upper()
        if candidate.lower().startswith("magnet:"):
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(candidate).query)
            for exact_topic in query.get("xt", []):
                prefix = "urn:btih:"
                if exact_topic.lower().startswith(prefix):
                    value = exact_topic[len(prefix):]
                    if BTIH_PATTERN.fullmatch(value):
                        return value.upper()
    return None


def parse_torznab(payload, provider_id, provider_name):
    root = parse_xml(payload)
    if _local_name(root.tag) == "error":
        return {
            "kind": "error",
            "code": _integer(root.attrib.get("code")),
            "description": root.attrib.get("description", ""),
        }
    if _local_name(root.tag) != "rss":
        raise TorznabError("Unexpected Torznab root")
    items = [element for element in root.iter() if _local_name(element.tag) == "item"]
    if len(items) > MAX_RESULTS:
        raise TorznabError("Torznab result limit exceeded")
    results = []
    for item in items:
        attributes = _attributes(item)
        categories = []
        for value in attributes.get("category", []):
            for token in value.split(","):
                category = _integer(token.strip())
                if category is not None:
                    categories.append(category)
        categories = sorted(set(categories))
        seeders = _integer((attributes.get("seeders") or [None])[0])
        peers = _integer((attributes.get("peers") or [None])[0])
        leechers = max(0, peers - seeders) if peers is not None and seeders is not None else None
        infohash = _infohash(attributes)
        link = _child_text(item, "link")
        enclosure = next(
            (child.attrib.get("url", "") for child in item if _local_name(child.tag) == "enclosure"),
            "",
        )
        guid = _child_text(item, "guid")
        acquisition = "magnet" if infohash else "torrent" if link or enclosure else None
        if acquisition is None:
            continue
        results.append(
            {
                "providerId": provider_id,
                "providerName": provider_name,
                "name": _child_text(item, "title"),
                "sizeBytes": _integer((attributes.get("size") or [_child_text(item, "size")])[0]),
                "seeders": seeders,
                "leechers": leechers,
                "publishedAt": _published(_child_text(item, "pubDate")),
                "categoryIds": categories,
                "access": "public",
                "acquisition": acquisition,
                "_dedup": f"btih:{infohash}" if infohash else f"guid:{provider_id}:{guid}",
                "_link": link or enclosure,
                "_privateFixture": "private.torrent" in (link or enclosure),
            }
        )
    return {"kind": "results", "results": results}


def product_results(parsed):
    if parsed.get("kind") != "results":
        return parsed
    seen = set()
    results = []
    for result in parsed["results"]:
        if any(6000 <= category <= 6999 for category in result["categoryIds"]):
            continue
        key = result["_dedup"]
        if key in seen:
            continue
        seen.add(key)
        results.append({key: value for key, value in result.items() if not key.startswith("_")})
    return sorted(
        results,
        key=lambda result: (
            result["seeders"] is None,
            -(result["seeders"] or 0),
            result["providerId"],
            result["name"].casefold(),
        ),
    )


def canonicalize_mini(payload):
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TorznabError("Malformed Jackett Mini JSON") from error
    results = []
    for item in document.get("results", []):
        results.append(
            {
                "providerId": item["providerId"],
                "providerName": item["providerName"],
                "name": item["name"],
                "sizeBytes": item.get("sizeBytes"),
                "seeders": item.get("seeders"),
                "leechers": item.get("leechers"),
                "publishedAt": _canonical_json_date(item.get("publishedAt")),
                "categoryIds": item["categoryIds"],
                "access": item["access"],
                "acquisition": item["acquisition"],
            }
        )
    return {
        "partial": document.get("partial"),
        "providers": [
            {"id": provider["id"], "state": provider["state"]}
            for provider in document.get("providers", [])
        ],
        "results": results,
    }


def _canonical_json_date(value):
    if not value:
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=datetime.timezone.utc)
        return parsed.astimezone(datetime.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    except (TypeError, ValueError, OverflowError):
        return None


def body_base64(payload):
    return base64.b64encode(payload).decode("ascii")
