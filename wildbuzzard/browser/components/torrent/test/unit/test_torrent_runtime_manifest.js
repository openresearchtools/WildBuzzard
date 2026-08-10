/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { TorrentRuntimeManifestTestUtils } = ChromeUtils.importESModule(
  "resource:///modules/TorrentManager.sys.mjs"
);

const COMMIT = "1".repeat(40);
const SOURCE =
  "share/wildbuzzard/torrent/wildbuzzard-torrent-runtime-1.0.0-111111111111-source.tar.xz";
const SBOM = "share/wildbuzzard/torrent/sbom.cdx.json";

function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const hash = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hash.initWithString("sha256");
  hash.update(bytes, bytes.length);
  return Array.from(hash.finish(false), character =>
    character.charCodeAt(0).toString(16).padStart(2, "0")
  ).join("");
}

function manifest() {
  const files = [
    ["WEBTORRENT-LICENSE", "2".repeat(64), false],
    ["WILDBUZZARD-LICENSE", "3".repeat(64), false],
    ["bin/wildbuzzard-torrent", "4".repeat(64), true],
    ["node/LICENSE", "5".repeat(64), false],
    ["node/bin/node", "6".repeat(64), true],
    [SBOM, "7".repeat(64), false],
    [SOURCE, "8".repeat(64), false],
  ]
    .map(([path, digest, executable]) => ({
      path,
      size: 1,
      sha256: digest,
      executable,
    }))
    .sort((left, right) => (left.path < right.path ? -1 : 1));
  const payload = files
    .map(
      file =>
        `${file.path}\0${file.size}\0${file.sha256}\0${file.executable ? 1 : 0}\n`
    )
    .join("");
  return {
    schema: 3,
    component: "wildbuzzard-torrent-runtime",
    version: "1.0.0",
    protocolVersion: 1,
    wildbuzzardCommit: COMMIT,
    webTorrentVersion: "3.0.21",
    webTorrentImportCommit: "9".repeat(40),
    packageLockSha256: "a".repeat(64),
    dependencyLockSha256: "a".repeat(64),
    nodeVersion: "22.23.2",
    nodeArchiveSha256:
      "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307",
    utpBuiltFromSource: true,
    platform: "linux-x64",
    architecture: "x86_64",
    correspondingSource: SOURCE,
    sourceSha256: "8".repeat(64),
    sbom: SBOM,
    licenseLocations: [
      "WEBTORRENT-LICENSE",
      "WILDBUZZARD-LICENSE",
      "node/LICENSE",
    ],
    payloadSha256: sha256(payload),
    files,
  };
}

add_task(function test_accepts_complete_provenance_manifest() {
  const files = TorrentRuntimeManifestTestUtils.validate(manifest());
  Assert.equal(files.size, 7, "Every declared runtime file is accepted");
});

add_task(function test_rejects_identity_and_provenance_mutations() {
  const mutations = [
    value => (value.schema = 2),
    value => (value.component = "torrent"),
    value => (value.protocolVersion = 2),
    value => (value.dependencyLockSha256 = "b".repeat(64)),
    value => (value.architecture = "aarch64"),
    value => (value.correspondingSource = "../source.tar.xz"),
    value => (value.sourceSha256 = "c".repeat(64)),
    value => (value.sbom = "sbom.json"),
    value => value.licenseLocations.reverse(),
  ];
  for (const mutate of mutations) {
    const value = manifest();
    mutate(value);
    Assert.throws(
      () => TorrentRuntimeManifestTestUtils.validate(value),
      /torrent runtime/i,
      "The changed runtime provenance is rejected"
    );
  }
});
