/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WildBuzzardBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WildBuzzardBlockerService.sys.mjs"
);

const BLOCKER_ENABLED_PREF = "wildbuzzard.blocker.enabled";
const EARLY_SCRIPTLET_DIAGNOSTICS_PREF =
  "wildbuzzard.blocker.earlyScriptletInjection.diagnostics";
const EARLY_SCRIPTLET_PARSER_BLOCK_TIMEOUT_PREF =
  "wildbuzzard.blocker.earlyScriptletInjection.parserBlockTimeoutMs";
const EARLY_SCRIPTLET_TEST_PARSER_BLOCK_TIMEOUT_MS = 10000;
const TEST_URL =
  "https://example.com/browser/browser/components/blocker/test/browser/file_early_scriptlet_injection.html";
const SCRIPTLET = 'globalThis.__wfProbe = "scriptlet-ran-first";';

let originalGetCosmeticResources;
let originalInitializeEngineWithRetry;
let originalWhenEngineReady;
let engineReadyDelayMs = 0;

function urlFor(testCase) {
  return `${TEST_URL}?case=${testCase}&nonce=${Date.now()}-${Math.random()}`;
}

function resourcesForCase(testCase) {
  switch (testCase) {
    case "ordering":
      return {
        generichide: true,
        injected_script: SCRIPTLET,
      };
    case "regression":
      return {
        generichide: true,
        hide_selectors: ["#hide-target"],
        injected_script: SCRIPTLET,
        procedural_actions: [
          {
            selector: [{ type: "css-selector", arg: "#procedural-target" }],
          },
        ],
      };
    case "noscriptlet":
      return {
        generichide: true,
      };
    case "timeout":
      return {
        generichide: true,
        injected_script: SCRIPTLET,
      };
    default:
      return null;
  }
}

async function openProbePage(testCase) {
  return BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: urlFor(testCase),
    waitForLoad: true,
  });
}

async function readProbeState(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const win = content.wrappedJSObject;
    const hideTarget = content.document.getElementById("hide-target");
    const proceduralTarget =
      content.document.getElementById("procedural-target");
    return {
      diagnostics: win.__wildbuzzardBlockerEarlyScriptletDiagnostics || null,
      hiddenDisplay: content.getComputedStyle(hideTarget).display,
      probe: win.__wfProbe,
      proceduralDisplay: content.getComputedStyle(proceduralTarget).display,
      readyState: content.document.readyState,
      seen: win.__wfProbeSeenByFirstScript,
    };
  });
}

async function withDiagnostics(task, extraPrefs = []) {
  await SpecialPowers.pushPrefEnv({
    set: [
      [BLOCKER_ENABLED_PREF, true],
      [EARLY_SCRIPTLET_DIAGNOSTICS_PREF, true],
      ...extraPrefs,
    ],
  });
  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

function earlyScriptletTimeoutPref() {
  return [
    EARLY_SCRIPTLET_PARSER_BLOCK_TIMEOUT_PREF,
    EARLY_SCRIPTLET_TEST_PARSER_BLOCK_TIMEOUT_MS,
  ];
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

add_setup(function setup() {
  originalGetCosmeticResources = WildBuzzardBlockerService.getCosmeticResources;
  originalInitializeEngineWithRetry =
    WildBuzzardBlockerService._initializeEngineWithRetry;
  originalWhenEngineReady = WildBuzzardBlockerService.whenEngineReady;

  WildBuzzardBlockerService._initializeEngineWithRetry = async function () {};
  WildBuzzardBlockerService.getCosmeticResources = function (url) {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("file_early_scriptlet_injection.html")) {
      return null;
    }
    return resourcesForCase(parsed.searchParams.get("case"));
  };

  WildBuzzardBlockerService.whenEngineReady = async function () {
    if (!engineReadyDelayMs) {
      return;
    }
    // Deliberately model delayed engine initialization in this timing test.
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, engineReadyDelayMs));
  };

  registerCleanupFunction(() => {
    WildBuzzardBlockerService.getCosmeticResources =
      originalGetCosmeticResources;
    WildBuzzardBlockerService._initializeEngineWithRetry =
      originalInitializeEngineWithRetry;
    WildBuzzardBlockerService.whenEngineReady = originalWhenEngineReady;
    engineReadyDelayMs = 0;
  });
});

add_task(async function test_scriptlet_wins_ordering() {
  await withDiagnostics(async () => {
    const tab = await openProbePage("ordering");
    try {
      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.seen,
        "scriptlet-ran-first",
        "The scriptlet should run before the first inline head script"
      );
      Assert.equal(
        state.diagnostics?.path,
        "early-inject",
        "Diagnostics should record the early injection path"
      );
      Assert.greaterOrEqual(
        state.diagnostics.durationMs,
        0,
        "Diagnostics should record a non-negative parser block duration"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  }, [earlyScriptletTimeoutPref()]);
});

add_task(async function test_cosmetic_and_procedural_paths_still_apply() {
  await withDiagnostics(async () => {
    const tab = await openProbePage("regression");
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await ContentTaskUtils.waitForCondition(() => {
          const hidden = content.document.getElementById("hide-target");
          const procedural =
            content.document.getElementById("procedural-target");
          return (
            content.getComputedStyle(hidden).display === "none" &&
            content.getComputedStyle(procedural).display === "none"
          );
        }, "Waiting for cosmetic and procedural hiding");
      });

      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.seen,
        "scriptlet-ran-first",
        "The regression payload should still inject the scriptlet early"
      );
      Assert.equal(
        state.hiddenDisplay,
        "none",
        "Cosmetic hide selectors should still apply"
      );
      Assert.equal(
        state.proceduralDisplay,
        "none",
        "Procedural actions should still apply"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  }, [earlyScriptletTimeoutPref()]);
});

add_task(async function test_timeout_unblocks_parser_and_falls_back_late() {
  await withDiagnostics(async () => {
    engineReadyDelayMs = 250;
    const tab = await openProbePage("timeout");
    try {
      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.readyState,
        "complete",
        "The page should finish loading"
      );
      Assert.equal(
        state.seen,
        "page-ran-first",
        "The timeout fallback should unblock before the delayed scriptlet runs"
      );
      Assert.equal(
        state.diagnostics?.path,
        "timeout-fallback",
        "Diagnostics should record the timeout fallback path"
      );
      await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.wrappedJSObject.__wfProbe === "scriptlet-ran-first",
          "Waiting for the late timeout-fallback scriptlet"
        );
      });
    } finally {
      engineReadyDelayMs = 0;
      await BrowserTestUtils.removeTab(tab);
    }
  });
});

add_task(async function test_latency_diagnostics() {
  await withDiagnostics(async () => {
    const noScriptletDurations = [];
    const scriptletDurations = [];

    for (const testCase of ["noscriptlet", "noscriptlet", "noscriptlet"]) {
      const tab = await openProbePage(testCase);
      try {
        const state = await readProbeState(tab.linkedBrowser);
        Assert.equal(
          state.diagnostics?.path,
          "no-scriptlet-fast-unblock",
          "No-scriptlet pages should unblock without scriptlet compilation"
        );
        noScriptletDurations.push(state.diagnostics.durationMs);
      } finally {
        await BrowserTestUtils.removeTab(tab);
      }
    }

    for (const testCase of ["ordering", "ordering", "ordering"]) {
      const tab = await openProbePage(testCase);
      try {
        const state = await readProbeState(tab.linkedBrowser);
        Assert.equal(
          state.diagnostics?.path,
          "early-inject",
          "Scriptlet pages should use the early injection path"
        );
        scriptletDurations.push(state.diagnostics.durationMs);
      } finally {
        await BrowserTestUtils.removeTab(tab);
      }
    }

    info(
      `WildBuzzardBlocker early parser block median no-scriptlet duration: ${median(
        noScriptletDurations
      )}ms`
    );
    info(
      `WildBuzzardBlocker early parser block median scriptlet duration: ${median(
        scriptletDurations
      )}ms`
    );
  }, [earlyScriptletTimeoutPref()]);
});
