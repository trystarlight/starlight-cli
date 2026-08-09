import type { AgentDriverToolDefinition } from "./protocol.js";

export const AGENT_TOOL_REJECTION_SCHEMA_VERSION =
  "starlight.agent-tool-rejection.v1" as const;

const AGENT_TOOL_ARGUMENT_MAXIMUM_BYTES = 32_000;
const SUPPORTED_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "allOf",
  "const",
  "default",
  "description",
  "else",
  "enum",
  "if",
  "items",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "not",
  "oneOf",
  "pattern",
  "properties",
  "required",
  "then",
  "type",
  "uniqueItems",
]);

interface SchemaError {
  readonly instancePath: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertSupportedDynamicToolSchema(
  schemaValue: unknown,
  schemaPath = "inputSchema",
): void {
  if (schemaValue === true || schemaValue === false) return;
  if (!record(schemaValue)) {
    throw new Error(
      `Dynamic tool schema ${schemaPath} must be an object or boolean`,
    );
  }
  for (const keyword of Object.keys(schemaValue)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(
        `Dynamic tool schema ${schemaPath}.${keyword} is unsupported`,
      );
    }
  }
  const properties = schemaValue["properties"];
  if (properties !== undefined) {
    if (!record(properties)) {
      throw new Error(
        `Dynamic tool schema ${schemaPath}.properties must be an object`,
      );
    }
    for (const [field, propertySchema] of Object.entries(properties)) {
      assertSupportedDynamicToolSchema(
        propertySchema,
        `${schemaPath}.properties.${field}`,
      );
    }
  }
  for (const keyword of ["items", "if", "then", "else", "not"] as const) {
    const nested = schemaValue[keyword];
    if (nested !== undefined) {
      assertSupportedDynamicToolSchema(nested, `${schemaPath}.${keyword}`);
    }
  }
  for (const keyword of ["allOf", "oneOf"] as const) {
    const branches = schemaValue[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) {
      throw new Error(
        `Dynamic tool schema ${schemaPath}.${keyword} must be an array`,
      );
    }
    branches.forEach((branch, index) => {
      assertSupportedDynamicToolSchema(
        branch,
        `${schemaPath}.${keyword}.${String(index)}`,
      );
    });
  }
}

function pointer(path: string, segment: string | number) {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function error(
  instancePath: string,
  keyword: string,
  params: Readonly<Record<string, unknown>> = {},
): SchemaError {
  return { instancePath, keyword, params };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function matchesType(value: unknown, type: string) {
  switch (type) {
    case "object":
      return record(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function discriminatedOneOfErrors(
  branches: readonly unknown[],
  value: unknown,
  instancePath: string,
): SchemaError[] | null {
  if (!record(value)) return null;
  const candidates: {
    readonly branch: Readonly<Record<string, unknown>>;
    readonly value: unknown;
  }[] = [];
  for (const branch of branches) {
    if (!record(branch)) return null;
    const properties = branch["properties"];
    if (!record(properties)) return null;
    const discriminator = properties["kind"];
    if (!record(discriminator) || !("const" in discriminator)) return null;
    candidates.push({ branch, value: discriminator["const"] });
  }
  const selected = candidates.find((candidate) =>
    sameValue(candidate.value, value["kind"]),
  );
  return selected === undefined
    ? [error(pointer(instancePath, "kind"), "enum")]
    : schemaErrors(selected.branch, value, instancePath);
}

function schemaErrors(
  schemaValue: unknown,
  value: unknown,
  instancePath = "",
): SchemaError[] {
  if (schemaValue === true) return [];
  if (schemaValue === false) return [error(instancePath, "false schema")];
  if (!record(schemaValue)) return [error(instancePath, "schema")];
  const errors: SchemaError[] = [];
  const type = schemaValue["type"];
  if (typeof type === "string" && !matchesType(value, type)) {
    return [error(instancePath, "type", { type })];
  }
  if ("const" in schemaValue && !sameValue(value, schemaValue["const"])) {
    errors.push(
      error(instancePath, "const", {
        allowedValue: schemaValue["const"],
      }),
    );
  }
  const enumValues = schemaValue["enum"];
  if (
    Array.isArray(enumValues) &&
    !enumValues.some((entry) => sameValue(entry, value))
  ) {
    errors.push(error(instancePath, "enum"));
  }
  if (typeof value === "string") {
    const minimum = schemaValue["minLength"];
    const maximum = schemaValue["maxLength"];
    if (typeof minimum === "number" && value.length < minimum) {
      errors.push(error(instancePath, "minLength", { limit: minimum }));
    }
    if (typeof maximum === "number" && value.length > maximum) {
      errors.push(error(instancePath, "maxLength", { limit: maximum }));
    }
    const pattern = schemaValue["pattern"];
    if (typeof pattern === "string" && !new RegExp(pattern, "u").test(value)) {
      errors.push(error(instancePath, "pattern"));
    }
  }
  if (typeof value === "number") {
    const minimum = schemaValue["minimum"];
    const maximum = schemaValue["maximum"];
    if (typeof minimum === "number" && value < minimum) {
      errors.push(error(instancePath, "minimum", { limit: minimum }));
    }
    if (typeof maximum === "number" && value > maximum) {
      errors.push(error(instancePath, "maximum", { limit: maximum }));
    }
  }
  if (Array.isArray(value)) {
    const minimum = schemaValue["minItems"];
    const maximum = schemaValue["maxItems"];
    if (typeof minimum === "number" && value.length < minimum) {
      errors.push(error(instancePath, "minItems", { limit: minimum }));
    }
    if (typeof maximum === "number" && value.length > maximum) {
      errors.push(error(instancePath, "maxItems", { limit: maximum }));
    }
    if (
      schemaValue["uniqueItems"] === true &&
      new Set(value.map((entry) => JSON.stringify(entry))).size !== value.length
    ) {
      errors.push(error(instancePath, "uniqueItems"));
    }
    if ("items" in schemaValue) {
      value.forEach((entry, index) => {
        errors.push(
          ...schemaErrors(
            schemaValue["items"],
            entry,
            pointer(instancePath, index),
          ),
        );
      });
    }
  }
  if (record(value)) {
    const required = schemaValue["required"];
    if (Array.isArray(required)) {
      for (const field of required) {
        if (typeof field === "string" && !(field in value)) {
          errors.push(
            error(instancePath, "required", { missingProperty: field }),
          );
        }
      }
    }
    const properties = record(schemaValue["properties"])
      ? schemaValue["properties"]
      : {};
    if (schemaValue["additionalProperties"] === false) {
      for (const field of Object.keys(value)) {
        if (!(field in properties)) {
          errors.push(
            error(instancePath, "additionalProperties", {
              additionalProperty: field,
            }),
          );
        }
      }
    }
    for (const [field, propertySchema] of Object.entries(properties)) {
      if (field in value) {
        errors.push(
          ...schemaErrors(
            propertySchema,
            value[field],
            pointer(instancePath, field),
          ),
        );
      }
    }
  }
  const allOf = schemaValue["allOf"];
  if (Array.isArray(allOf)) {
    for (const branch of allOf) {
      errors.push(...schemaErrors(branch, value, instancePath));
    }
  }
  const condition = schemaValue["if"];
  if (condition !== undefined) {
    const matches = schemaErrors(condition, value, instancePath).length === 0;
    const selected = matches ? schemaValue["then"] : schemaValue["else"];
    if (selected !== undefined) {
      errors.push(...schemaErrors(selected, value, instancePath));
    }
  }
  const forbidden = schemaValue["not"];
  if (
    forbidden !== undefined &&
    schemaErrors(forbidden, value, instancePath).length === 0
  ) {
    errors.push(error(instancePath, "not"));
  }
  const oneOf = schemaValue["oneOf"];
  if (Array.isArray(oneOf)) {
    const discriminated = discriminatedOneOfErrors(oneOf, value, instancePath);
    if (discriminated !== null) {
      errors.push(...discriminated);
      return errors;
    }
    const branchErrors = oneOf.map((branch) =>
      schemaErrors(branch, value, instancePath),
    );
    if (branchErrors.filter((branch) => branch.length === 0).length !== 1) {
      for (const branch of branchErrors) errors.push(...branch);
      errors.push(error(instancePath, "oneOf"));
    }
  }
  return errors;
}

function pointerSegments(instancePath: string) {
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function fieldFor(error: SchemaError) {
  const segments = pointerSegments(error.instancePath);
  if (
    error.keyword === "required" &&
    typeof error.params["missingProperty"] === "string"
  ) {
    segments.push(error.params["missingProperty"]);
  }
  if (
    error.keyword === "additionalProperties" &&
    typeof error.params["additionalProperty"] === "string"
  ) {
    segments.push(error.params["additionalProperty"]);
  }
  const field = segments.length === 0 ? "arguments" : segments.join(".");
  return field.length <= 160 && /^[A-Za-z0-9_.-]+$/u.test(field)
    ? field
    : "arguments";
}

function numericParameter(error: SchemaError, key: string) {
  const value = error.params[key];
  return typeof value === "number" && Number.isFinite(value)
    ? String(value)
    : null;
}

function messageFor(error: SchemaError, field: string) {
  const limit = numericParameter(error, "limit");
  switch (error.keyword) {
    case "required":
      return `${field} is required.`;
    case "additionalProperties":
      return `${field} is not supported.`;
    case "minLength":
      return limit === null
        ? `${field} is too short.`
        : `${field} must contain at least ${limit} characters.`;
    case "maxLength":
      return limit === null
        ? `${field} is too long.`
        : `${field} must contain at most ${limit} characters.`;
    case "minItems":
      return limit === null
        ? `${field} has too few items.`
        : `${field} must contain at least ${limit} items.`;
    case "maxItems":
      return limit === null
        ? `${field} has too many items.`
        : `${field} must contain at most ${limit} items.`;
    case "uniqueItems":
      return `${field} must not contain duplicate items.`;
    case "minimum":
      return limit === null
        ? `${field} is too small.`
        : `${field} must be at least ${limit}.`;
    case "maximum":
      return limit === null
        ? `${field} is too large.`
        : `${field} must be at most ${limit}.`;
    case "enum":
      return `${field} is not one of the supported values.`;
    case "const": {
      const allowed = error.params["allowedValue"];
      return typeof allowed === "number" && Number.isSafeInteger(allowed)
        ? `${field} must equal ${String(allowed)}.`
        : `${field} is not one of the supported values.`;
    }
    case "oneOf":
      return `${field} must match exactly one supported input shape.`;
    case "not":
      return `${field} contains an unsupported field combination.`;
    case "false schema":
      return `${field} is not supported with the selected input shape.`;
    case "pattern":
      return `${field} has an unsupported format.`;
    case "type": {
      const expected =
        typeof error.params["type"] === "string"
          ? error.params["type"]
          : "value";
      return `${field} must be a valid ${expected}.`;
    }
    default:
      return `${field} is invalid.`;
  }
}

function firstUsefulError(errors: readonly SchemaError[]) {
  const priority = (error: SchemaError) => {
    if (
      [
        "additionalProperties",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minimum",
        "maximum",
        "pattern",
        "type",
      ].includes(error.keyword)
    ) {
      return 0;
    }
    if (error.keyword === "false schema") return 1;
    if (error.keyword === "enum") return 2;
    if (error.keyword === "const") return fieldFor(error) === "mode" ? 4 : 3;
    if (error.keyword === "required") return 5;
    if (["oneOf", "not", "if"].includes(error.keyword)) return 7;
    return 6;
  };
  return errors
    .map((schemaError, index) => ({ schemaError, index }))
    .sort(
      (left, right) =>
        priority(left.schemaError) - priority(right.schemaError) ||
        left.index - right.index,
    )[0]?.schemaError;
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
  const errors = schemaErrors(definition.inputSchema, value);
  if (errors.length === 0) {
    return {
      valid: true as const,
      value: value as Readonly<Record<string, unknown>>,
    };
  }
  const selected = firstUsefulError(errors);
  const field = selected === undefined ? "arguments" : fieldFor(selected);
  const message =
    selected === undefined
      ? "Tool arguments are invalid."
      : messageFor(selected, field);
  return {
    valid: false as const,
    failure: {
      schemaVersion: AGENT_TOOL_REJECTION_SCHEMA_VERSION,
      code: "invalid-tool-arguments" as const,
      toolName: definition.name,
      field,
      message: message.slice(0, 300),
    },
  };
}
