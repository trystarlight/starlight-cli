import { describe, expect, it } from "vitest";

import {
  CODEX_DYNAMIC_TOOL_ARGUMENTS_MAXIMUM_BYTES,
  CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES,
  codexDynamicToolArgumentsFailure,
  codexDynamicToolResult,
} from "./codex-app-server-client.js";

describe("Codex dynamic tool transport integrity", () => {
  it("preserves an H3-like fingerprint beyond byte offset 8,721", () => {
    const schemaFingerprint = `sha256:${"d".repeat(64)}`;
    const text = JSON.stringify({
      schemaVersion: "starlight.agent-media-schema-navigation.v1",
      endpointId: "minimax/h3/text-to-video",
      providerDescription: "x".repeat(8_700),
      schemaFingerprint,
      disposition: "node",
    });
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(8_721);
    expect(text.indexOf(schemaFingerprint)).toBeGreaterThan(8_721);

    const result = codexDynamicToolResult({
      toolName: "starlight_get_media_model_schema",
      success: true,
      text,
    });

    expect(result).toEqual({ success: true, text });
    expect(JSON.parse(result.text)).toMatchObject({ schemaFingerprint });
  });

  it("returns no result prefix beyond the exact 128,000-byte ceiling", () => {
    const prefix = "authoritative-schema-prefix:";
    const text = `${prefix}${"é".repeat(CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES)}`;
    const result = codexDynamicToolResult({
      toolName: "starlight_get_media_model_schema",
      success: true,
      text,
    });

    expect(result.success).toBe(false);
    expect(result.text).not.toContain(prefix);
    expect(result.text).not.toContain("é");
    expect(JSON.parse(result.text)).toMatchObject({
      schemaVersion: "starlight.dynamic-tool-result-transport.v1",
      complete: false,
      code: "result-too-large",
      measuredBytes: Buffer.byteLength(text, "utf8"),
      maximumBytes: CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES,
      mustStop: true,
    });
  });

  it("measures the 32,000-byte argument boundary as UTF-8", () => {
    const within = { prompt: "é".repeat(15_990) };
    expect(
      Buffer.byteLength(JSON.stringify(within), "utf8"),
    ).toBeLessThanOrEqual(CODEX_DYNAMIC_TOOL_ARGUMENTS_MAXIMUM_BYTES);
    expect(codexDynamicToolArgumentsFailure(within)).toBeNull();

    const oversized = { prompt: "é".repeat(16_000) };
    const failure = codexDynamicToolArgumentsFailure(oversized);
    expect(failure?.success).toBe(false);
    expect(JSON.parse(failure?.text ?? "{}")).toMatchObject({
      schemaVersion: "starlight.dynamic-tool-arguments-transport.v1",
      complete: false,
      code: "arguments-too-large",
      measuredBytes: Buffer.byteLength(JSON.stringify(oversized), "utf8"),
      maximumBytes: CODEX_DYNAMIC_TOOL_ARGUMENTS_MAXIMUM_BYTES,
      mustStop: true,
      operationCreated: false,
      providerDispatchStarted: false,
    });
  });
});
