/* SPDX-License-Identifier: AGPL-3.0-or-later */

import type { TSchema } from "typebox";
import { Value } from "typebox/value";

export function assertBrowserToolParameters(
  tool: string,
  parameters: TSchema,
  value: unknown
): void {
  if (Value.Check(parameters, value)) {
    return;
  }
  const error = Value.Errors(parameters, value)[0];
  throw new Error(
    `${tool}: invalid arguments${error ? ` at ${error.instancePath || "/"}: ${error.message}` : ""}`
  );
}
