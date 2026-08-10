import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  parseAgentMediaExecutionResult,
  parseAgentMediaSchemaBinding,
  parseAgentMediaToolFailure,
} from "./driver-api-client.js";
import { validateDynamicToolArguments } from "./dynamic-tool-validation.js";
import { applyAgentDriverBoundArguments } from "./protocol.js";

type JsonRecord = Readonly<Record<string, unknown>>;

function record(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as JsonRecord;
}

async function fixture() {
  return record(
    JSON.parse(
      await readFile(
        new URL("../fixtures/media-tool-reattachment.v1.json", import.meta.url),
        "utf8",
      ),
    ) as unknown,
    "Media reattachment fixture",
  );
}

describe("public media reattachment compatibility fixture", () => {
  it("transports refs and enforces the exact bound multi-output grammar", async () => {
    const value = await fixture();
    expect(JSON.stringify(value["schemaProjection"])).toContain('"$ref"');
    const binding = parseAgentMediaSchemaBinding(value["schemaBinding"]);
    const proposal = record(
      value["validMultiOutputProposal"],
      "Valid proposal",
    );

    expect(
      validateDynamicToolArguments(binding.toolDefinition, proposal),
    ).toMatchObject({ valid: true });
    expect(
      applyAgentDriverBoundArguments(binding.toolDefinition, proposal),
    ).toMatchObject({
      kind: "video",
      schemaBindingId: binding.bindingId,
      outputCount: 2,
    });

    const invalid = structuredClone(proposal) as Record<string, unknown>;
    const variants = invalid["variants"] as Array<Record<string, unknown>>;
    variants[0] = {
      ...variants[0],
      providerInput: { prompt: "Duration is deliberately missing." },
    };
    expect(
      validateDynamicToolArguments(binding.toolDefinition, invalid),
    ).toMatchObject({
      valid: false,
      failure: { field: "variants.0.providerInput.duration" },
    });
  });

  it("preserves typed failures and durable acceptance as separate outcomes", async () => {
    const value = await fixture();
    expect(
      parseAgentMediaToolFailure(value["invalidFieldExample"]),
    ).toMatchObject({
      field: "arguments.variants.0.providerInput.duration",
      mechanicallyRetryable: true,
      mustStop: false,
    });
    expect(
      parseAgentMediaToolFailure(value["staleSchemaExample"]),
    ).toMatchObject({
      phase: "schema-stale",
      schemaRefreshAllowed: true,
    });
    expect(
      parseAgentMediaToolFailure(value["internalFailureExample"]),
    ).toMatchObject({
      phase: "platform-internal",
      mechanicallyRetryable: false,
      mustStop: true,
    });
    expect(
      parseAgentMediaExecutionResult(value["acceptedResult"]),
    ).toMatchObject({
      disposition: "accepted",
      expectedOperationCount: 2,
      operations: [{ ordinal: 1 }, { ordinal: 2 }],
    });
  });
});
