import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import process from "node:process";

const forbidden = [
  ["/", "Users", "/"],
  ["bam", "bozlor"],
  ["xpriment", "626"],
  ["starlight", "-platform"],
  ["next/", "agent-usability"],
  ["local", "-live"],
  ["workspace:", "*"],
  ["AGENTS", ".md"],
].map(
  (parts) =>
    new RegExp(
      parts.join("").replaceAll(/[.*+?^${}()|[\]\\/]/gu, "\\$&"),
      "iu",
    ),
);

const candidates = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean)
  .filter(
    (file) => !file.startsWith("node_modules/") && !file.startsWith("dist/"),
  );

for (const file of candidates) {
  const raw = readFileSync(file, "utf8");
  const contents =
    file === ".gitignore"
      ? raw.replace(/^AGENTS\.md$/gmu, "[local-instruction-file]")
      : raw;
  for (const pattern of forbidden) {
    if (pattern.test(contents) || pattern.test(file)) {
      throw new Error(
        `Public-safety check failed for ${file}: ${String(pattern)}`,
      );
    }
  }
}

const pack = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    encoding: "utf8",
  }),
);
const files = pack[0]?.files?.map((entry) => entry.path) ?? [];
const unexpected = files.filter(
  (file) =>
    file !== "package.json" &&
    !["README.md", "PROTOCOL.md", "SECURITY.md"].includes(file) &&
    file !== "fixtures/media-tool-reattachment.v1.json" &&
    !file.startsWith("dist/"),
);
if (unexpected.length > 0) {
  throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);
}
if (!files.includes("dist/main.js"))
  throw new Error("Package is missing dist/main.js");
process.stdout.write(
  `${JSON.stringify({ schemaVersion: "starlight.package-audit.v1", files })}\n`,
);
