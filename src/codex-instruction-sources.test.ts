import { describe, expect, it } from "vitest";

import { hasOnlyCodexHomeInstructionSource } from "./codex-instruction-sources.js";

const instructionFileName = ["AGENTS", ".md"].join("");
const overrideInstructionFileName = ["AGENTS", ".override.md"].join("");

describe("Codex instruction sources", () => {
  it("accepts empty sources and the default Codex home instruction file", () => {
    const environment = { HOME: "/opt/starlight-home" };

    expect(hasOnlyCodexHomeInstructionSource(undefined, environment)).toBe(
      true,
    );
    expect(hasOnlyCodexHomeInstructionSource([], environment)).toBe(true);
    expect(
      hasOnlyCodexHomeInstructionSource(
        [`/opt/starlight-home/.codex/${instructionFileName}`],
        environment,
      ),
    ).toBe(true);
  });

  it("accepts an override file directly inside an explicit Codex home", () => {
    expect(
      hasOnlyCodexHomeInstructionSource(
        [`/opt/starlight-codex/${overrideInstructionFileName}`],
        { CODEX_HOME: "/opt/starlight-codex" },
      ),
    ).toBe(true);
  });

  it.each([
    [[`/private/project/${instructionFileName}`]],
    [[`/opt/starlight-home/.codex/nested/${instructionFileName}`]],
    [
      [
        `/opt/starlight-home/.codex/${instructionFileName}`,
        `/opt/starlight-home/.codex/${overrideInstructionFileName}`,
      ],
    ],
    [[42]],
    [`/opt/starlight-home/.codex/${instructionFileName}`],
    [null],
  ])("rejects a non-Codex-home or malformed source list: %j", (value) => {
    expect(
      hasOnlyCodexHomeInstructionSource(value, { HOME: "/opt/starlight-home" }),
    ).toBe(false);
  });

  it("rejects reported sources when the Codex home cannot be resolved", () => {
    expect(hasOnlyCodexHomeInstructionSource([], {})).toBe(true);
    expect(
      hasOnlyCodexHomeInstructionSource([`/tmp/${instructionFileName}`], {}),
    ).toBe(false);
    expect(
      hasOnlyCodexHomeInstructionSource([instructionFileName], {
        CODEX_HOME: "relative/codex-home",
      }),
    ).toBe(false);
  });
});
