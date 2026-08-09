import AjvModule, {
  type AnySchema,
  type ErrorObject,
  type ValidateFunction,
} from "ajv";

import type { AgentDriverToolDefinition } from "./protocol.js";

export const AGENT_TOOL_REJECTION_SCHEMA_VERSION =
  "starlight.agent-tool-rejection.v1" as const;

const AGENT_TOOL_ARGUMENT_MAXIMUM_BYTES = 32_000;
const Ajv = AjvModule.default;

function compiler(): InstanceType<typeof Ajv> {
  return new Ajv({
    allErrors: true,
    strict: false,
    validateFormats: false,
    allowUnionTypes: true,
  });
}

function compile(schema: unknown): ValidateFunction {
  try {
    return compiler().compile(schema as AnySchema);
  } catch (cause) {
    throw new Error("Dynamic tool schema is not valid JSON Schema", { cause });
  }
}

export function assertSupportedDynamicToolSchema(schemaValue: unknown): void {
  compile(schemaValue);
}

function segments(error: ErrorObject): string[] {
  const path = error.instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (
    error.keyword === "required" &&
    typeof error.params["missingProperty"] === "string"
  ) {
    path.push(error.params["missingProperty"]);
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params["additionalProperty"] === "string"
  ) {
    path.push(error.params["additionalProperty"]);
  }
  return path;
}

function fieldFor(error: ErrorObject): string {
  const field = segments(error).join(".");
  return field.length > 0 && field.length <= 200 ? field : "arguments";
}

function messageFor(error: ErrorObject, field: string): string {
  switch (error.keyword) {
    case "required":
      return `${field} is required.`;
    case "additionalProperties":
      return `${field} is not supported.`;
    case "type":
      return `${field} must be a valid ${String(error.params["type"] ?? "value")}.`;
    case "enum":
      return `${field} is not one of the supported values.`;
    case "const":
      return typeof error.params["allowedValue"] === "number"
        ? `${field} must equal ${String(error.params["allowedValue"])}.`
        : `${field} is not one of the supported values.`;
    case "minLength":
      return `${field} must contain at least ${String(error.params["limit"])} characters.`;
    case "maxLength":
      return `${field} must contain at most ${String(error.params["limit"])} characters.`;
    case "minItems":
      return `${field} must contain at least ${String(error.params["limit"])} items.`;
    case "maxItems":
      return `${field} must contain at most ${String(error.params["limit"])} items.`;
    case "minimum":
      return `${field} must be at least ${String(error.params["limit"])}.`;
    case "maximum":
      return `${field} must be at most ${String(error.params["limit"])}.`;
    case "pattern":
    case "format":
      return `${field} has an unsupported format.`;
    case "uniqueItems":
      return `${field} must not contain duplicate items.`;
    case "oneOf":
      return `${field} must match exactly one supported input shape.`;
    case "not":
      return `${field} contains an unsupported field combination.`;
    default:
      return `${field} ${error.message ?? "is invalid"}.`;
  }
}

function useful(errors: readonly ErrorObject[]): ErrorObject | undefined {
  const priority = (error: ErrorObject) => {
    if (error.keyword === "additionalProperties") return 0;
    if (
      ["type", "pattern", "format", "minimum", "maximum"].includes(
        error.keyword,
      )
    )
      return 1;
    if (
      [
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "uniqueItems",
      ].includes(error.keyword)
    )
      return 2;
    if (["enum", "const"].includes(error.keyword)) return 3;
    if (error.keyword === "required") return 4;
    return 5;
  };
  return [...errors].sort((left, right) => priority(left) - priority(right))[0];
}

export function validateDynamicToolArguments(
  definition: AgentDriverToolDefinition,
  value: unknown,
) {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = undefined;
  }
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength >
      AGENT_TOOL_ARGUMENT_MAXIMUM_BYTES
  ) {
    return {
      valid: false as const,
      failure: {
        schemaVersion: AGENT_TOOL_REJECTION_SCHEMA_VERSION,
        code: "invalid-tool-arguments" as const,
        toolName: definition.name,
        field: "arguments",
        message: "Tool arguments exceed the supported size.",
      },
    };
  }
  const validate = compile(definition.inputSchema);
  if (validate(value)) {
    return {
      valid: true as const,
      value: value as Readonly<Record<string, unknown>>,
    };
  }
  const error = useful(validate.errors ?? []);
  const field = error === undefined ? "arguments" : fieldFor(error);
  return {
    valid: false as const,
    failure: {
      schemaVersion: AGENT_TOOL_REJECTION_SCHEMA_VERSION,
      code: "invalid-tool-arguments" as const,
      toolName: definition.name,
      field,
      message: (error === undefined
        ? "Tool arguments are invalid."
        : messageFor(error, field)
      ).slice(0, 300),
    },
  };
}
