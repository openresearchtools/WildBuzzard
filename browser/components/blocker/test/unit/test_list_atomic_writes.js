/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { EngineCache } = ChromeUtils.importESModule(
  "resource:///modules/internal/EngineCache.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);

const DESCRIPTORS = [
  {
    filename: "atomic.txt",
    url: "https://example.com/atomic.txt",
  },
];
const LIST_RECORDS = [
  {
    filename: "atomic.txt",
    text: "||example.com^\n",
    url: "https://example.com/atomic.txt",
  },
];

function engineWithBytes(bytes) {
  return {
    serialize() {
      return new Uint8Array(bytes);
    },
  };
}

add_task(
  async function test_list_store_write_text_preserves_destination_on_failure() {
    const path = PathUtils.join(PathUtils.profileDir, "list-store-atomic.txt");
    const tmpPath = `${path}.tmp`;

    await IOUtils.writeUTF8(path, "old contents");
    await IOUtils.makeDirectory(tmpPath);
    try {
      await Assert.rejects(
        ListStore.writeText(path, "new contents"),
        /directory|write|operation|denied|exists/i,
        "An unusable atomic temp path should reject the write"
      );
    } finally {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true, recursive: true });
    }

    Assert.equal(
      await IOUtils.readUTF8(path),
      "old contents",
      "A failed temp-file write should leave the destination untouched"
    );

    await IOUtils.remove(path, { ignoreAbsent: true });
  }
);

add_task(async function test_list_store_write_json_uses_atomic_text_writer() {
  const path = PathUtils.join(PathUtils.profileDir, "list-store-atomic.json");
  await ListStore.writeJSON(path, { ok: true });

  Assert.deepEqual(
    JSON.parse(await IOUtils.readUTF8(path)),
    { ok: true },
    "ListStore.writeJSON should write valid JSON"
  );
  Assert.ok(
    !(await IOUtils.exists(`${path}.tmp`)),
    "A successful atomic JSON write should leave no temp file"
  );

  await IOUtils.remove(path, { ignoreAbsent: true });
});

add_task(async function test_engine_cache_writes_use_tmp_paths() {
  await EngineCache.clear();

  try {
    await EngineCache.write(
      engineWithBytes([1, 2, 3]),
      DESCRIPTORS,
      LIST_RECORDS
    );
    const cacheRoot = ListStore.cacheRootPath();
    const children = await IOUtils.getChildren(cacheRoot);
    Assert.equal(
      children.length,
      2,
      "Engine cache should write data and metadata"
    );
    Assert.ok(
      children.every(path => !path.endsWith(".tmp")),
      "Successful engine cache writes should leave no temp files"
    );
  } finally {
    await EngineCache.clear();
  }
});

add_task(
  async function test_engine_cache_preserves_existing_cache_on_failure() {
    await EngineCache.clear();
    await EngineCache.write(
      engineWithBytes([1, 2, 3]),
      DESCRIPTORS,
      LIST_RECORDS
    );

    const originalBytes = Array.from(await EngineCache.read());
    const cacheRoot = ListStore.cacheRootPath();
    const enginePath = (await IOUtils.getChildren(cacheRoot)).find(path =>
      PathUtils.filename(path).startsWith("adblock-engine.")
    );
    Assert.ok(enginePath, "The initial engine cache file should exist");
    const tmpPath = `${enginePath}.tmp`;
    await IOUtils.makeDirectory(tmpPath);

    try {
      await Assert.rejects(
        EngineCache.write(
          engineWithBytes([4, 5, 6]),
          DESCRIPTORS,
          LIST_RECORDS
        ),
        /directory|write|operation|denied|exists/i,
        "An unusable cache temp path should reject the write"
      );
    } finally {
      await IOUtils.remove(tmpPath, { ignoreAbsent: true, recursive: true });
    }

    Assert.deepEqual(
      Array.from(await EngineCache.read()),
      originalBytes,
      "A failed temp-file cache write should leave the prior cache intact"
    );

    await EngineCache.clear();
  }
);
