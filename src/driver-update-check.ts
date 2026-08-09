import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { compareVersions } from "./codex-runtime-discovery.js";
import {
  STARLIGHT_CLI_VERSION,
  STARLIGHT_DRIVER_COMPATIBILITY,
  STARLIGHT_PRODUCTION_ORIGIN,
} from "./version.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

export interface DriverUpdateStatus {
  readonly installedVersion: string;
  readonly latestVersion: string | null;
  readonly minimumVersion: string | null;
  readonly updateAvailable: boolean | null;
  readonly compatible: boolean | null;
  readonly source: "network" | "cache" | "unavailable";
  readonly checkedAt: number | null;
}

export interface DriverUpdateCheckDependencies {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly cachePath?: string;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
}

interface CachedDriverUpdate {
  readonly schemaVersion: "starlight.driver-update-cache.v1";
  readonly checkedAt: number;
  readonly latestVersion: string;
  readonly minimumVersion: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDriverVersions(
  latestVersion: string,
  minimumVersion: string,
) {
  compareVersions(latestVersion, minimumVersion);
  return {
    latestVersion:
      compareVersions(
        latestVersion,
        STARLIGHT_DRIVER_COMPATIBILITY.recommendedVersion,
      ) >= 0
        ? latestVersion
        : STARLIGHT_DRIVER_COMPATIBILITY.recommendedVersion,
    minimumVersion:
      compareVersions(
        minimumVersion,
        STARLIGHT_DRIVER_COMPATIBILITY.minimumVersion,
      ) >= 0
        ? minimumVersion
        : STARLIGHT_DRIVER_COMPATIBILITY.minimumVersion,
  };
}

function parseUpdate(value: unknown) {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== "starlight.driver-update.v1"
  ) {
    throw new Error("Starlight driver update response is invalid");
  }
  const latestVersion = value["latestVersion"];
  const minimumVersion = value["minimumVersion"];
  if (typeof latestVersion !== "string" || typeof minimumVersion !== "string") {
    throw new Error("Starlight driver update versions are invalid");
  }
  return normalizeDriverVersions(latestVersion, minimumVersion);
}

function parseCache(value: unknown): CachedDriverUpdate {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== "starlight.driver-update-cache.v1" ||
    typeof value["checkedAt"] !== "number" ||
    !Number.isSafeInteger(value["checkedAt"]) ||
    typeof value["latestVersion"] !== "string" ||
    typeof value["minimumVersion"] !== "string"
  ) {
    throw new Error("Starlight driver update cache is invalid");
  }
  return {
    schemaVersion: "starlight.driver-update-cache.v1",
    checkedAt: value["checkedAt"],
    ...normalizeDriverVersions(value["latestVersion"], value["minimumVersion"]),
  };
}

function project(
  update: Pick<
    CachedDriverUpdate,
    "checkedAt" | "latestVersion" | "minimumVersion"
  >,
  source: DriverUpdateStatus["source"],
): DriverUpdateStatus {
  return {
    installedVersion: STARLIGHT_CLI_VERSION,
    latestVersion: update.latestVersion,
    minimumVersion: update.minimumVersion,
    updateAvailable:
      compareVersions(STARLIGHT_CLI_VERSION, update.latestVersion) < 0,
    compatible:
      compareVersions(STARLIGHT_CLI_VERSION, update.minimumVersion) >= 0,
    source,
    checkedAt: update.checkedAt,
  };
}

export async function checkDriverUpdate(
  dependencies: DriverUpdateCheckDependencies = {},
): Promise<DriverUpdateStatus> {
  const fetcher = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const cachePath =
    dependencies.cachePath ??
    resolve(homedir(), "Library", "Caches", "Starlight", "driver-update.json");
  const endpoint =
    dependencies.endpoint ??
    `${STARLIGHT_PRODUCTION_ORIGIN}/.well-known/starlight-driver`;
  const cached = await readFile(cachePath, "utf8")
    .then((raw) => parseCache(JSON.parse(raw) as unknown))
    .catch(() => null);
  if (cached !== null && cached.checkedAt + CACHE_TTL_MS > now()) {
    return project(cached, "cache");
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    dependencies.timeoutMs ?? 2_000,
  );
  try {
    const response = await fetcher(endpoint, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`Update endpoint returned ${String(response.status)}`);
    const update = parseUpdate((await response.json()) as unknown);
    const next: CachedDriverUpdate = {
      schemaVersion: "starlight.driver-update-cache.v1",
      checkedAt: now(),
      ...update,
    };
    await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
    const temporary = `${cachePath}.${String(process.pid)}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await rename(temporary, cachePath);
    } finally {
      await rm(temporary, { force: true });
    }
    return project(next, "network");
  } catch {
    return cached === null
      ? {
          installedVersion: STARLIGHT_CLI_VERSION,
          latestVersion: null,
          minimumVersion: null,
          updateAvailable: null,
          compatible: null,
          source: "unavailable",
          checkedAt: null,
        }
      : project(cached, "cache");
  } finally {
    clearTimeout(timeout);
  }
}
