import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileCodexThreadStore } from "./codex-thread-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (path) => await rm(path, { recursive: true })),
  );
});

describe("Codex thread store", () => {
  it("persists the exact adapter-local session mapping across store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "starlight-codex-thread-store-"));
    temporaryDirectories.push(root);
    const path = join(root, "driver", "threads.json");
    const first = new FileCodexThreadStore(path, () => 1_000);
    await first.write(
      "https://local.test/mcp:workspace_test:session_test",
      "thread_codex_test",
    );

    const second = new FileCodexThreadStore(path, () => 2_000);
    await expect(
      second.read("https://local.test/mcp:workspace_test:session_test"),
    ).resolves.toBe("thread_codex_test");
    await expect(
      second.read("another-resource:workspace_test:session_test"),
    ).resolves.toBeNull();
    expect(await readFile(path, "utf8")).not.toContain("credential");
  });

  it("fails closed on malformed durable mappings", async () => {
    const root = await mkdtemp(
      join(tmpdir(), "starlight-codex-thread-store-invalid-"),
    );
    temporaryDirectories.push(root);
    const path = join(root, "threads.json");
    await writeFile(path, '{"schemaVersion":"wrong","threads":{}}\n');

    await expect(
      new FileCodexThreadStore(path).read("session_test"),
    ).rejects.toThrow(/mapping is invalid/u);
  });
});
