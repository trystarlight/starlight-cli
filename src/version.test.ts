import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  STARLIGHT_CLI_VERSION,
  STARLIGHT_DRIVER_COMPATIBILITY,
} from "./version.js";

describe("published version contract", () => {
  it("keeps the package and runtime versions aligned", async () => {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: unknown };

    expect(packageJson.version).toBe(STARLIGHT_CLI_VERSION);
  });

  it("ships the production compatibility floor and recommendation", () => {
    expect(STARLIGHT_DRIVER_COMPATIBILITY).toEqual({
      minimumVersion: "0.7.0",
      recommendedVersion: "0.8.0",
    });
  });
});
