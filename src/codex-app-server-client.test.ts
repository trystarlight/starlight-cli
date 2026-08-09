import { describe, expect, it } from "vitest";

import {
  CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES,
  codexDynamicToolResult,
} from "./codex-app-server-client.js";

describe("Codex dynamic tool result integrity", () => {
  it("preserves a live schema result larger than the retired 4,000-character limit", () => {
    const fingerprint = `sha256:${"a".repeat(64)}`;
    const text = JSON.stringify({
      schemaVersion: "starlight.fal-live-schema.v1",
      inputSchema: {
        type: "object",
        description: "x".repeat(6_000),
      },
      schemaFingerprint: fingerprint,
    });

    const result = codexDynamicToolResult({
      toolName: "starlight_get_media_model_schema",
      success: true,
      text,
    });

    expect(text.length).toBeGreaterThan(4_000);
    expect(result).toEqual({ success: true, text });
    expect(JSON.parse(result.text)).toMatchObject({
      schemaFingerprint: fingerprint,
    });
  });

  it("fails closed instead of slicing a result above the explicit byte ceiling", () => {
    const result = codexDynamicToolResult({
      toolName: "starlight_get_media_model_schema",
      success: true,
      text: "é".repeat(CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES),
    });

    expect(result.success).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({
      schemaVersion: "starlight.driver-tool-result-error.v1",
      code: "tool-result-too-large",
      toolName: "starlight_get_media_model_schema",
      maximumBytes: CODEX_DYNAMIC_TOOL_RESULT_MAXIMUM_BYTES,
      operationCreated: false,
      providerDispatchStarted: false,
    });
    expect(result.text).not.toContain("é");
  });
});
