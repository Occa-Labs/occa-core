#!/usr/bin/env node
// Executable entry. The BYORT box runs this (via the `occa-claude-gateway`
// bin, a systemd unit, or `npx @occa/gateway-claude-code`). All command-line
// behaviour lives in ./cli; this file only wires argv to it.

import { runCli } from "./cli";

await runCli(process.argv.slice(2));
