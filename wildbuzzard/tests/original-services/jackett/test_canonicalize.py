# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import unittest

from canonicalize import TorznabError, canonicalize_mini, parse_torznab, parse_xml, product_results


class CanonicalizeTest(unittest.TestCase):
    def test_errors_are_not_empty_results(self):
        parsed = parse_torznab(b'<error code="100" description="Invalid API Key"/>', "fixture", "Fixture")
        self.assertEqual(parsed, {"kind": "error", "code": 100, "description": "Invalid API Key"})

    def test_categories_are_preserved_with_peer_semantics_and_infohash_deduplication(self):
        payload = b'''<?xml version="1.0"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel>
<item><title>safe</title><guid>one</guid><pubDate>Mon, 10 Aug 2026 12:00:00 GMT</pubDate>
<torznab:attr name="category" value="2000"/><torznab:attr name="seeders" value="10"/>
<torznab:attr name="peers" value="13"/><torznab:attr name="size" value="123"/>
<torznab:attr name="infohash" value="0123456789abcdef0123456789abcdef01234567"/></item>
<item><title>duplicate</title><guid>two</guid><torznab:attr name="category" value="2000"/>
<torznab:attr name="infohash" value="0123456789ABCDEF0123456789ABCDEF01234567"/></item>
<item><title>adult</title><guid>three</guid><torznab:attr name="category" value="6010"/>
<torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"/></item>
</channel></rss>'''
        parsed = parse_torznab(payload, "fixture", "Fixture")
        normalized = product_results(parsed)
        self.assertEqual(len(normalized), 2)
        by_name = {item["name"]: item for item in normalized}
        self.assertEqual(by_name["safe"]["leechers"], 3)
        self.assertEqual(by_name["adult"]["categoryIds"], [6010])

    def test_dtd_and_malformed_xml_fail_closed(self):
        for payload in (b'<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss>&x;</rss>', b"<rss>"):
            with self.subTest(payload=payload):
                with self.assertRaises(TorznabError):
                    parse_xml(payload)

    def test_mini_volatile_identifiers_are_removed(self):
        payload = json.dumps(
            {
                "searchId": "A" * 32,
                "partial": False,
                "providers": [{"id": "fixture", "state": "ok", "elapsedMs": 12}],
                "results": [
                    {
                        "resultId": "B" * 32,
                        "providerId": "fixture",
                        "providerName": "Fixture",
                        "name": "safe",
                        "sizeBytes": None,
                        "seeders": None,
                        "leechers": None,
                        "publishedAt": None,
                        "categoryIds": [2000],
                        "access": "public",
                        "acquisition": "magnet",
                    }
                ],
            }
        ).encode()
        normalized = canonicalize_mini(payload)
        self.assertNotIn("searchId", normalized)
        self.assertNotIn("elapsedMs", normalized["providers"][0])
        self.assertNotIn("resultId", normalized["results"][0])


if __name__ == "__main__":
    unittest.main()
