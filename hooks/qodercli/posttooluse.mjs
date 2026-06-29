#!/usr/bin/env node
/**
 * Qoder CLI PostToolUse hook for context-mode.
 * Passthrough: reads stdin using standard end-event, exits 0.
 */

const raw = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "").trim()));
  process.stdin.resume();
});

// Consume stdin to prevent pipe blocking
void raw;
process.exit(0);
