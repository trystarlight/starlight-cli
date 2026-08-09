import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = "starlight.codex-thread-store.v1";
const MAXIMUM_THREADS = 1_000;

interface StoredThread {
  readonly threadId: string;
  readonly updatedAt: number;
}

interface StoredThreads {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly threads: Readonly<Record<string, StoredThread>>;
}

export interface CodexThreadStore {
  read(sessionKey: string): Promise<string | null>;
  write(sessionKey: string, threadId: string): Promise<void>;
}

function validText(value: unknown, maximum: number) {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function parseStore(raw: string): StoredThreads {
  const value = JSON.parse(raw) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !("threads" in value) ||
    typeof value.threads !== "object" ||
    value.threads === null ||
    Array.isArray(value.threads)
  ) {
    throw new Error("Stored Codex thread mapping is invalid");
  }
  const threads: Record<string, StoredThread> = {};
  for (const [key, entry] of Object.entries(value.threads)) {
    if (
      !validText(key, 1_000) ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      !("threadId" in entry) ||
      !validText(entry.threadId, 500) ||
      !("updatedAt" in entry) ||
      typeof entry.updatedAt !== "number" ||
      !Number.isSafeInteger(entry.updatedAt) ||
      entry.updatedAt < 0
    ) {
      throw new Error("Stored Codex thread mapping is invalid");
    }
    threads[key] = { threadId: entry.threadId, updatedAt: entry.updatedAt };
  }
  return { schemaVersion: SCHEMA_VERSION, threads };
}

export class FileCodexThreadStore implements CodexThreadStore {
  constructor(
    private readonly path = join(
      homedir(),
      ".starlight",
      "codex-driver-threads.json",
    ),
    private readonly now: () => number = Date.now,
  ) {}

  private async load() {
    try {
      return parseStore(await readFile(this.path, "utf8"));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {
          schemaVersion: SCHEMA_VERSION,
          threads: {},
        } satisfies StoredThreads;
      }
      throw error;
    }
  }

  async read(sessionKey: string) {
    if (!validText(sessionKey, 1_000))
      throw new Error("Codex session mapping key is invalid");
    return (await this.load()).threads[sessionKey]?.threadId ?? null;
  }

  async write(sessionKey: string, threadId: string) {
    if (!validText(sessionKey, 1_000) || !validText(threadId, 500)) {
      throw new Error("Codex thread mapping is invalid");
    }
    const stored = await this.load();
    const entries = Object.entries({
      ...stored.threads,
      [sessionKey]: { threadId, updatedAt: this.now() },
    })
      .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
      .slice(0, MAXIMUM_THREADS);
    const next: StoredThreads = {
      schemaVersion: SCHEMA_VERSION,
      threads: Object.fromEntries(entries),
    };
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${String(process.pid)}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
  }
}
