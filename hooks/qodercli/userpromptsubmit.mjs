#!/usr/bin/env node
/**
 * Qoder CLI UserPromptSubmit hook for context-mode.
 * Passthrough: reads stdin using standard end-event, exits 0.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const raw = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "").trim()));
  process.stdin.resume();
});

const { initSecurity } = await import("../core/routing.mjs");
const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

// Consume stdin; passthrough for now
void raw;
process.exit(0);
