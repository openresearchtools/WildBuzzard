// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import test from "node:test";
import { servicePaths } from "../src/service.mjs";

test("service state and packaged runtime have separate ownership", () => {
  const paths = servicePaths();
  assert.match(paths.state, /buzzard(?:-\d+)?[\\/]torrent-search$/);
  assert.equal(paths.runtime, "/usr/lib/buzzard-torrent-search/runtime");
  assert.notEqual(paths.data, paths.runtime);
});
