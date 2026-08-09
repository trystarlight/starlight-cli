#!/usr/bin/env node

import { createProgram, CLI_EXIT } from "./program.js";

createProgram()
  .parseAsync(process.argv)
  .catch((error: unknown) => {
    const message =
      error instanceof Error ? error.message : "The command failed.";
    process.stderr.write(`${message}\n`);
    process.exitCode = CLI_EXIT.failed;
  });
