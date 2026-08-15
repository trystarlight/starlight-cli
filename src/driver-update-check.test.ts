import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkDriverUpdate } from "./driver-update-check.js";

const temporaryRoots: string[] = [];

async function cachePath() {
  const root = await mkdtemp(join(tmpdir(), "starlight-driver-update-test-"));
  temporaryRoots.push(root);
  return join(root, "driver-update.json");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("bounded driver update check", () => {
  it("reports installed, latest, and minimum versions separately and caches the result", async () => {
    const path = await cachePath();
    const fetcher = vi.fn(async () =>
      Response.json({
        schemaVersion: "starlight.driver-update.v1",
        latestVersion: "0.9.0",
        minimumVersion: "0.7.0",
      }),
    );

    await expect(
      checkDriverUpdate({
        fetch: fetcher,
        now: () => 5_000,
        cachePath: path,
        endpoint: "https://app.trystarlight.io/.well-known/starlight-driver",
      }),
    ).resolves.toEqual({
      installedVersion: "0.8.1",
      latestVersion: "0.9.0",
      minimumVersion: "0.7.0",
      updateAvailable: true,
      compatible: true,
      source: "network",
      checkedAt: 5_000,
    });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: "starlight.driver-update-cache.v1",
      checkedAt: 5_000,
      latestVersion: "0.9.0",
      minimumVersion: "0.7.0",
    });
  });

  it("uses a fresh cache without contacting the network", async () => {
    const path = await cachePath();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: "starlight.driver-update-cache.v1",
        checkedAt: 10_000,
        latestVersion: "0.8.0",
        minimumVersion: "0.7.0",
      }),
      "utf8",
    );
    const fetcher = vi.fn();

    await expect(
      checkDriverUpdate({
        fetch: fetcher,
        now: () => 11_000,
        cachePath: path,
      }),
    ).resolves.toMatchObject({
      source: "cache",
      updateAvailable: false,
      compatible: true,
      checkedAt: 10_000,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns an explicit unavailable result without corrupting JSON output state", async () => {
    const path = await cachePath();

    await expect(
      checkDriverUpdate({
        fetch: async () => {
          throw new Error("offline");
        },
        now: () => 20_000,
        cachePath: path,
        timeoutMs: 10,
      }),
    ).resolves.toEqual({
      installedVersion: "0.8.1",
      latestVersion: null,
      minimumVersion: null,
      updateAvailable: null,
      compatible: null,
      source: "unavailable",
      checkedAt: null,
    });
  });
});
