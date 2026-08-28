#!/usr/bin/env node
import { main } from "./index.js";

/**
 * The published `baya` binary. Kept separate from `index.ts` so importing the
 * CLI in a test never runs it or exits the process.
 */
main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(`baya: ${(err as Error).message}\n`);
    process.exitCode = 2;
  });
