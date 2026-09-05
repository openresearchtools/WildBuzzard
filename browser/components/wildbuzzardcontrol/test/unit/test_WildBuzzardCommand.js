/* SPDX-License-Identifier: AGPL-3.0-or-later */

"use strict";

const { WildBuzzardCommandTestUtils, handleWildBuzzardCommand } =
  ChromeUtils.importESModule("resource:///modules/WildBuzzardCommand.sys.mjs");

add_task(function test_structured_fill_does_not_require_a_positional_ref() {
  const fields = [{ ref: "e4", value: "Agent input" }];
  const args = { kind: "fill", fields };
  WildBuzzardCommandTestUtils.applyPositionals("act", args, []);
  Assert.deepEqual(args.fields, fields);
  Assert.ok(!("ref" in args));
  Assert.equal(args.clear, true);
});

add_task(async function test_onion_authorization_stdin_and_redaction() {
  do_get_profile();
  const { TorRouting } = ChromeUtils.importESModule(
    "resource:///modules/TorRouting.sys.mjs"
  );
  const { OnionAuthStore } = ChromeUtils.importESModule(
    "resource:///modules/OnionAuthStore.sys.mjs"
  );
  const address = "2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid";
  const key = btoa("k".repeat(32));
  const input = { address, key, name: "test identity" };
  const run = (argv, stdin) =>
    handleWildBuzzardCommand({
      version: 1,
      cwd: PathUtils.profileDir,
      argv: ["--json", ...argv],
      stdin,
    });
  const originalSet = TorRouting.setOnionAuthorization;
  const originalRemove = TorRouting.removeOnionAuthorization;
  const originalComplete = TorRouting.completeOnionAuthorization;
  let completed = null;
  TorRouting.setOnionAuthorization = (target, value) =>
    OnionAuthStore.update(target, value);
  TorRouting.removeOnionAuthorization = target =>
    OnionAuthStore.update(target, null);
  TorRouting.completeOnionAuthorization = target => {
    completed = target;
  };
  try {
    for (const [argv, stdin] of [
      [["--input", JSON.stringify(input), "onion-auth", "set"]],
      [["onion-auth", "set", address, "--key=" + key]],
      [["--input", "-", "onion-auth", "set"], '{"key":"' + key],
    ]) {
      const result = await run(argv, stdin);
      Assert.equal(result.exitCode, 1);
      Assert.ok(
        !JSON.stringify(result).includes(key),
        "Errors do not expose keys"
      );
    }
    let result = await run(
      ["--input", "-", "onion-auth", "set"],
      JSON.stringify(input)
    );
    Assert.equal(result.exitCode, 0, result.stderr);
    Assert.equal(completed, address, "An agent can complete a pending prompt");
    Assert.ok(!result.stdout.includes(key));
    Assert.equal((await OnionAuthStore.load()).get(address).key, key);
    Assert.ok(
      !(await IOUtils.exists(OnionAuthStore.path)),
      "Agent keys default to session only"
    );
    result = await run(["onion-auth", "list"]);
    Assert.equal(result.exitCode, 0, result.stderr);
    Assert.ok(result.stdout.includes("test identity"));
    Assert.ok(!result.stdout.includes(key));
    result = await run([
      "onion-auth",
      "privacy",
      address,
      "--private-mode",
      "false",
    ]);
    Assert.equal(result.exitCode, 0, result.stderr);
    Assert.equal((await OnionAuthStore.list())[0].privateMode, false);
    OnionAuthStore.lock();
    Assert.equal(
      (await OnionAuthStore.load()).get(address).key,
      key,
      "Trusting an existing site remembers its key across restart"
    );
    Assert.ok(!result.stdout.includes(key));
    result = await run(["onion-auth", "remove", address]);
    Assert.equal(result.exitCode, 0, result.stderr);
    Assert.equal((await OnionAuthStore.list()).length, 0);
  } finally {
    TorRouting.setOnionAuthorization = originalSet;
    TorRouting.removeOnionAuthorization = originalRemove;
    TorRouting.completeOnionAuthorization = originalComplete;
    OnionAuthStore.lock();
  }
});

add_task(function test_single_fill_still_requires_a_ref() {
  Assert.throws(
    () =>
      WildBuzzardCommandTestUtils.applyPositionals("act", { kind: "fill" }, []),
    /element ref/
  );
});

add_task(function test_boolean_flags_leave_positional_urls_intact() {
  const parse = argv =>
    WildBuzzardCommandTestUtils.parseToolFlags(argv, "tabs", {});
  const url = "https://example.com/";
  Assert.deepEqual(parse(["--tor", url]), {
    args: { tor: true },
    positionals: [url],
  });
  Assert.deepEqual(parse(["--private", "--background", url]), {
    args: { private: true, background: true },
    positionals: [url],
  });
  Assert.deepEqual(parse(["--tor", "false", url]), {
    args: { tor: false },
    positionals: [url],
  });
  Assert.deepEqual(parse(["--tor=false", url]), {
    args: { tor: false },
    positionals: [url],
  });
  Assert.throws(() => parse(["--tor=invalid", url]), /expected a boolean/);
});
