#!/usr/bin/env node

import { CommanderError } from "commander";

import { createProgram, CLI_EXIT } from "./program.js";

createProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    if (error instanceof CommanderError) {
      process.exitCode = error.exitCode === 0 ? CLI_EXIT.ok : CLI_EXIT.usage;
      return;
    }
    const message =
      error instanceof Error ? error.message : "The command failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = CLI_EXIT.failed;
  });
