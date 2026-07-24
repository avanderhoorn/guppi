#!/usr/bin/env node

const { main } = require("../dist/src/cli.js");

main(process.argv.slice(2))
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`guppi: ${message}`);
    process.exitCode = 1;
  });
