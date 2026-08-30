/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const WEB_OWNER = "web-search@extensions.wildbuzzard";
const TORRENT_OWNER = "torrent-search@extensions.wildbuzzard";

const { AddonTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/AddonTestUtils.sys.mjs"
);
const { BuzzardSearchBridge, WildBuzzardDiscoveryBridgeTestUtils: Bridge } =
  ChromeUtils.importESModule(
    "resource:///modules/WildBuzzardDiscoveryBridge.sys.mjs"
  );
AddonTestUtils.init(this);
AddonTestUtils.createAppInfo(
  "xpcshell@tests.mozilla.org",
  "XPCShell",
  "42",
  "42"
);

add_setup(async function setupAddonManager() {
  await AddonTestUtils.promiseStartupManager();
});

async function backgroundNamespaces(id, useAddonManager) {
  async function background() {
    async function canGetStatus(api) {
      try {
        await api.getStatus();
        return true;
      } catch {
        return false;
      }
    }
    browser.test.sendMessage("namespaces", {
      buzzardSearch: await canGetStatus(browser.buzzardSearch),
      torrentSearch: await canGetStatus(browser.torrentSearch),
    });
  }

  const extensionData = {
    manifest: {
      browser_specific_settings: { gecko: { id } },
      incognito: "not_allowed",
    },
    background,
  };
  if (useAddonManager) {
    extensionData.useAddonManager = useAddonManager;
  }
  const extension = ExtensionTestUtils.loadExtension(extensionData);
  await extension.startup();
  const namespaces = await extension.awaitMessage("namespaces");
  await extension.unload();
  return namespaces;
}

add_task(async function test_parent_api_exact_ids_without_native_permission() {
  Assert.deepEqual(await backgroundNamespaces(WEB_OWNER), {
    buzzardSearch: true,
    torrentSearch: false,
  });
  Assert.deepEqual(await backgroundNamespaces(TORRENT_OWNER), {
    buzzardSearch: false,
    torrentSearch: true,
  });
  Assert.deepEqual(
    await backgroundNamespaces("web-search@extensions.wildbuzzard.invalid"),
    {
      buzzardSearch: false,
      torrentSearch: false,
    }
  );
  Assert.deepEqual(await backgroundNamespaces(WEB_OWNER, "temporary"), {
    buzzardSearch: false,
    torrentSearch: false,
  });
  Assert.deepEqual(await backgroundNamespaces(TORRENT_OWNER, "temporary"), {
    buzzardSearch: false,
    torrentSearch: false,
  });
});

add_task(async function test_web_search_request_crosses_parent_api_boundary() {
  const operationId = "0cc29e8e-e9ca-4887-b3c2-ee68a8a8ba63";
  const expectedRequest = {
    schema: 1,
    requestId: operationId,
    query: "Debian Linux release",
    provider: "ddgs",
    maxResults: 10,
    timeoutSeconds: 30,
    page: 1,
    safeSearch: 1,
  };
  let received;
  const originalSearch = BuzzardSearchBridge.search;
  BuzzardSearchBridge.search = async (request, owner) => {
    received = {
      owner,
      request,
      input: Bridge.normalizeWebSearchRequest(request).input,
    };
    return {
      schema: 1,
      requestId: request.requestId,
      implementation: "buzzard-search",
      kind: "search",
      provider: request.provider,
      query: request.query,
      results: [],
    };
  };

  async function background() {
    const request = {
      schema: 1,
      requestId: "0cc29e8e-e9ca-4887-b3c2-ee68a8a8ba63",
      query: "Debian Linux release",
      provider: "ddgs",
      maxResults: 10,
      timeoutSeconds: 30,
      page: 1,
      safeSearch: 1,
    };
    try {
      const response = await browser.buzzardSearch.search(request);
      browser.test.sendMessage("search-response", response);
    } catch (error) {
      browser.test.sendMessage("search-response", { error: error.message });
    }
  }

  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: WEB_OWNER } },
      incognito: "not_allowed",
    },
    background,
  });
  try {
    await extension.startup();
    Assert.deepEqual(await extension.awaitMessage("search-response"), {
      schema: 1,
      requestId: operationId,
      implementation: "buzzard-search",
      kind: "search",
      provider: "ddgs",
      query: "Debian Linux release",
      results: [],
    });
    Assert.deepEqual(received, {
      owner: WEB_OWNER,
      request: {
        ...expectedRequest,
        engines: null,
        language: null,
        searxngUrl: null,
      },
      input: {
        schemaVersion: 1,
        query: "Debian Linux release",
        provider: "ddgs",
        maxResults: 10,
        timeoutSeconds: 30,
        page: 1,
        safeSearch: 1,
      },
    });
  } finally {
    BuzzardSearchBridge.search = originalSearch;
    await extension.unload();
  }
});

add_task(async function test_bridge_error_code_crosses_parent_api_boundary() {
  async function background() {
    try {
      await browser.buzzardSearch.search({
        schema: 1,
        requestId: "0cc29e8e-e9ca-4887-b3c2-ee68a8a8ba63",
        query: " ",
        provider: "ddgs",
        maxResults: 10,
        timeoutSeconds: 30,
        page: 1,
        safeSearch: 1,
      });
    } catch (error) {
      browser.test.sendMessage("search-error", error.message);
    }
  }

  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: WEB_OWNER } },
      incognito: "not_allowed",
    },
    background,
  });
  try {
    await extension.startup();
    Assert.equal(
      await extension.awaitMessage("search-error"),
      "[buzzard-search/invalid_request]"
    );
  } finally {
    await extension.unload();
  }
});

async function contentNamespaces(server, id) {
  async function background() {
    async function canGetStatus(api) {
      try {
        await api.getStatus();
        return true;
      } catch {
        return false;
      }
    }
    browser.test.sendMessage("background-namespaces", {
      buzzardSearch: await canGetStatus(browser.buzzardSearch),
      torrentSearch: await canGetStatus(browser.torrentSearch),
    });
  }

  async function contentScript() {
    async function canGetStatus(api) {
      try {
        await api.getStatus();
        return true;
      } catch {
        return false;
      }
    }
    browser.test.sendMessage("content-namespaces", {
      buzzardSearch: await canGetStatus(browser.buzzardSearch),
      torrentSearch: await canGetStatus(browser.torrentSearch),
    });
  }

  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id } },
      incognito: "not_allowed",
      content_scripts: [
        {
          matches: ["http://localhost/*"],
          js: ["content-script.js"],
        },
      ],
    },
    background,
    files: { "content-script.js": contentScript },
  });
  await extension.startup();
  const backgroundResult = await extension.awaitMessage(
    "background-namespaces"
  );
  const page = await ExtensionTestUtils.loadContentPage(
    `http://localhost:${server.identity.primaryPort}/discovery-api`
  );
  const contentResult = await extension.awaitMessage("content-namespaces");
  await page.close();
  await extension.unload();
  return { backgroundResult, contentResult };
}

add_task(async function test_discovery_apis_are_not_content_script_apis() {
  const server = createHttpServer();
  server.registerPathHandler("/discovery-api", (request, response) => {
    response.setHeader("Content-Type", "text/html", false);
    response.write("<!doctype html><title>discovery boundary</title>");
  });

  const web = await contentNamespaces(server, WEB_OWNER);
  Assert.equal(web.backgroundResult.buzzardSearch, true);
  Assert.deepEqual(web.contentResult, {
    buzzardSearch: false,
    torrentSearch: false,
  });

  const torrent = await contentNamespaces(server, TORRENT_OWNER);
  Assert.equal(torrent.backgroundResult.torrentSearch, true);
  Assert.deepEqual(torrent.contentResult, {
    buzzardSearch: false,
    torrentSearch: false,
  });
});

async function privatePageNamespaces(id) {
  async function pageScript() {
    async function canGetStatus(api) {
      try {
        await api.getStatus();
        return true;
      } catch {
        return false;
      }
    }
    browser.test.sendMessage("private-namespaces", {
      incognito: browser.extension.inIncognitoContext,
      buzzardSearch: await canGetStatus(browser.buzzardSearch),
      torrentSearch: await canGetStatus(browser.torrentSearch),
    });
  }

  const extension = ExtensionTestUtils.loadExtension({
    incognitoOverride: "spanning",
    manifest: {
      browser_specific_settings: { gecko: { id } },
    },
    files: {
      "page.html": "<!doctype html><script src='page.js'></script>",
      "page.js": pageScript,
    },
  });
  await extension.startup();
  const page = await ExtensionTestUtils.loadContentPage(
    `moz-extension://${extension.uuid}/page.html`,
    { privateBrowsing: true }
  );
  const namespaces = await extension.awaitMessage("private-namespaces");
  await page.close();
  await extension.unload();
  return namespaces;
}

add_task(async function test_discovery_apis_are_disabled_in_private_pages() {
  Assert.deepEqual(await privatePageNamespaces(WEB_OWNER), {
    incognito: true,
    buzzardSearch: false,
    torrentSearch: false,
  });
  Assert.deepEqual(await privatePageNamespaces(TORRENT_OWNER), {
    incognito: true,
    buzzardSearch: false,
    torrentSearch: false,
  });
});

add_task(async function test_spanning_background_has_no_discovery_api() {
  async function namespaces(id) {
    async function background() {
      async function canGetStatus(api) {
        try {
          await api.getStatus();
          return true;
        } catch {
          return false;
        }
      }
      browser.test.sendMessage("spanning-namespaces", {
        buzzardSearch: await canGetStatus(browser.buzzardSearch),
        torrentSearch: await canGetStatus(browser.torrentSearch),
      });
    }
    const extension = ExtensionTestUtils.loadExtension({
      incognitoOverride: "spanning",
      manifest: {
        browser_specific_settings: { gecko: { id } },
        incognito: "spanning",
      },
      background,
    });
    await extension.startup();
    const result = await extension.awaitMessage("spanning-namespaces");
    await extension.unload();
    return result;
  }

  for (const id of [WEB_OWNER, TORRENT_OWNER]) {
    Assert.deepEqual(await namespaces(id), {
      buzzardSearch: false,
      torrentSearch: false,
    });
  }
});
