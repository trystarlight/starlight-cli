import { isAbsolute, join, resolve } from "node:path";

export function configuredCodexHome(environment: NodeJS.ProcessEnv) {
  const configured = environment["CODEX_HOME"];
  const value =
    configured === undefined
      ? environment["HOME"] === undefined
        ? null
        : join(environment["HOME"], ".codex")
      : configured;
  return value !== null && isAbsolute(value) ? resolve(value) : null;
}

export function hasOnlyCodexHomeInstructionSource(
  value: unknown,
  environment: NodeJS.ProcessEnv,
) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 1) return false;

  const codexHome = configuredCodexHome(environment);
  if (codexHome === null) return value.length === 0;
  const instructionFileName = ["AGENTS", ".md"].join("");
  const overrideInstructionFileName = ["AGENTS", ".override.md"].join("");
  const allowed = new Set([
    join(codexHome, instructionFileName),
    join(codexHome, overrideInstructionFileName),
  ]);
  return value.every(
    (source) => typeof source === "string" && allowed.has(source),
  );
}
