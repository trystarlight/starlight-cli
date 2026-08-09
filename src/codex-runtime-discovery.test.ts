import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareVersions,
  discoverCodexExecutable,
  inspectCodexRuntime,
} from "./codex-runtime-discovery.js";

const temporaryRoots: string[] = [];

async function fakeCodex(version: string) {
  const root = await mkdtemp(join(tmpdir(), "starlight-codex-discovery-test-"));
  temporaryRoots.push(root);
  const executable = join(root, "codex");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf 'codex-cli ${version}\\n'\n`,
    "utf8",
  );
  await chmod(executable, 0o700);
  return { root, executable };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Codex runtime discovery", () => {
  it("discovers an executable from PATH and evaluates the App Server minimum", async () => {
    const { root, executable } = await fakeCodex("0.144.1");

    await expect(discoverCodexExecutable({ PATH: root })).resolves.toBe(
      executable,
    );
    await expect(inspectCodexRuntime({ PATH: root })).resolves.toMatchObject({
      executable,
      installedVersion: "0.144.1",
      minimumVersion: "0.144.0",
      compatible: true,
    });
  });

  it("rejects a relative override and reports older versions as incompatible", async () => {
    await expect(
      discoverCodexExecutable({ STARLIGHT_CODEX_PATH: "./codex" }),
    ).rejects.toThrow(/absolute/u);
    const { executable } = await fakeCodex("0.143.9");
    await expect(
      inspectCodexRuntime({ STARLIGHT_CODEX_PATH: executable }),
    ).resolves.toMatchObject({
      installedVersion: "0.143.9",
      compatible: false,
    });
    expect(compareVersions("0.144.0", "0.144.0")).toBe(0);
    expect(compareVersions("0.145.0", "0.144.9")).toBeGreaterThan(0);
  });
});
