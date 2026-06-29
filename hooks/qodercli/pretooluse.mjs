#!/usr/bin/env node
/**
 * Qoder CLI PreToolUse hook for context-mode.
 * Uses standard stdin (end-event based, no idle timeout) for qodercli compatibility.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Read stdin using standard end-event (no idle timeout — qodercli may keep pipe open)
const raw = await new Promise((resolve) => {
  let data = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk) => { data += chunk; });
  process.stdin.on("end", () => resolve(data.replace(/^\uFEFF/, "").trim()));
  process.stdin.resume();
});

const input = raw ? JSON.parse(raw) : {};

const { getInputProjectDir, getSessionId, QODER_CLI_OPTS } = await import("../session-helpers.mjs");
const { routePreToolUse, initSecurity } = await import("../core/routing.mjs");
const { formatDecision } = await import("../core/formatters.mjs");

const __hookDir = dirname(fileURLToPath(import.meta.url));
await initSecurity(resolve(__hookDir, "..", "..", "build"));

const tool = input.tool_name ?? "";
const toolInput = input.tool_input ?? {};
const projectDir = getInputProjectDir(input, QODER_CLI_OPTS);

const decision = routePreToolUse(tool, toolInput, projectDir, "qodercli", getSessionId(input, QODER_CLI_OPTS));
const response = formatDecision("qodercli", decision);

if (response) {
  process.stdout.write(JSON.stringify(response) + "\n");
}
