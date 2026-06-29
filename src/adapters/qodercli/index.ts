/**
 * adapters/qodercli — Qoder CLI platform adapter.
 *
 * Qoder CLI uses JSON stdin/stdout hooks with multi-level settings.json config.
 * Wire format is similar to Claude Code but requires `hookEventName` inside
 * `hookSpecificOutput` responses.
 *
 * Supported events: PreToolUse, PostToolUse, UserPromptSubmit, Stop.
 *
 * Doc refs:
 *   - Hooks: https://docs.qoder.com/en/cli/hooks.md
 *   - Using CLI: https://docs.qoder.com/en/cli/using-cli.md
 */

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";

import { BaseAdapter } from "../base.js";

import {
  HOOK_TYPES,
  PRE_TOOL_USE_MATCHER_PATTERN,
  buildHookCommand as buildQodercliHookCommand,
  isContextModeHook as isQodercliContextModeHook,
  REQUIRED_HOOKS,
  OPTIONAL_HOOKS,
  type HookType,
  type QodercliHookEntry,
} from "./hooks.js";

import type {
  HookAdapter,
  HookParadigm,
  PlatformCapabilities,
  DiagnosticResult,
  PreToolUseEvent,
  PostToolUseEvent,
  PreToolUseResponse,
  PostToolUseResponse,
  HookRegistration,
} from "../types.js";

interface QodercliHookInput {
  hook_event_name?: string;
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  extra?: Record<string, unknown>;
}

export class QodercliAdapter extends BaseAdapter implements HookAdapter {
  constructor() {
    super([".qoder"]);
  }

  readonly name = "Qoder CLI";
  readonly paradigm: HookParadigm = "json-stdio";

  readonly capabilities: PlatformCapabilities = {
    preToolUse: true,
    postToolUse: true,
    preCompact: false,
    sessionStart: false,
    canModifyArgs: true,
    canModifyOutput: false,
    canInjectSessionContext: true,
  };

  // ── Input parsing ──────────────────────────────────────

  parsePreToolUseInput(raw: unknown): PreToolUseEvent {
    const input = raw as QodercliHookInput;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  parsePostToolUseInput(raw: unknown): PostToolUseEvent {
    const input = raw as QodercliHookInput;
    const toolResponse = input.tool_response;
    return {
      toolName: input.tool_name ?? "",
      toolInput: input.tool_input ?? {},
      toolOutput: toolResponse == null
        ? ""
        : typeof toolResponse === "string"
          ? toolResponse
          : JSON.stringify(toolResponse),
      sessionId: this.extractSessionId(input),
      projectDir: this.getProjectDir(input),
      raw,
    };
  }

  // ── Response formatting ────────────────────────────────

  formatPreToolUseResponse(response: PreToolUseResponse): unknown {
    switch (response.decision) {
      case "deny":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: response.reason ?? "Blocked by context-mode",
          },
        };
      case "ask":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
          },
        };
      case "modify": {
        const ui = response.updatedInput ?? {};
        const isObj = ui !== null && typeof ui === "object" && !Array.isArray(ui);
        const isBashRedirect = isObj && "command" in ui;
        if (!isBashRedirect) {
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              updatedInput: ui,
            },
          };
        }
        const rawCmd = (ui as Record<string, unknown>).command;
        const cmd = typeof rawCmd === "string" ? rawCmd : "";
        const m = cmd.match(/^echo\s+"(.+)"$/s);
        const reason = m?.[1] ?? "Redirected to ctx_execute / ctx_fetch_and_index. Use context-mode MCP tools for data-heavy operations.";
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        };
      }
      case "context":
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext: response.additionalContext,
          },
        };
      default:
        return undefined;
    }
  }

  formatPostToolUseResponse(response: PostToolUseResponse): unknown {
    if (response.additionalContext) {
      return {
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: response.additionalContext,
        },
      };
    }
    return undefined;
  }

  // ── Configuration ──────────────────────────────────────

  getSettingsPath(): string {
    return resolve(".qoder", "settings.json");
  }

  override getInstructionFiles(): string[] {
    return ["AGENTS.md", "QODER.md"];
  }

  generateHookConfig(_pluginRoot: string): HookRegistration {
    const hooks: Record<string, QodercliHookEntry[]> = {};

    hooks[HOOK_TYPES.PRE_TOOL_USE] = [{
      matcher: PRE_TOOL_USE_MATCHER_PATTERN,
      hooks: [{ type: "command", command: buildQodercliHookCommand(HOOK_TYPES.PRE_TOOL_USE) }],
    }];

    hooks[HOOK_TYPES.POST_TOOL_USE] = [{
      hooks: [{ type: "command", command: buildQodercliHookCommand(HOOK_TYPES.POST_TOOL_USE) }],
    }];

    hooks[HOOK_TYPES.USER_PROMPT_SUBMIT] = [{
      hooks: [{ type: "command", command: buildQodercliHookCommand(HOOK_TYPES.USER_PROMPT_SUBMIT) }],
    }];

    hooks[HOOK_TYPES.STOP] = [{
      hooks: [{ type: "command", command: buildQodercliHookCommand(HOOK_TYPES.STOP) }],
    }];

    return hooks as unknown as HookRegistration;
  }

  readSettings(): Record<string, unknown> | null {
    const paths = this.getCandidateSettingsPaths();
    let merged: Record<string, unknown> | null = null;

    for (const configPath of paths) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (merged === null) {
          merged = parsed;
        } else {
          if (parsed.hooks && typeof parsed.hooks === "object") {
            const existingHooks = (merged.hooks ?? {}) as Record<string, unknown>;
            const newHooks = parsed.hooks as Record<string, unknown>;
            for (const [eventType, entries] of Object.entries(newHooks)) {
              const existing = existingHooks[eventType] as unknown[] | undefined;
              if (Array.isArray(existing) && Array.isArray(entries)) {
                (existingHooks[eventType] as unknown[]) = [...existing, ...entries];
              } else {
                existingHooks[eventType] = entries;
              }
            }
            merged.hooks = existingHooks;
          }
        }
      } catch {
        continue;
      }
    }

    return merged;
  }

  writeSettings(settings: Record<string, unknown>): void {
    const configPath = this.getSettingsPath();
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  }

  // ── Diagnostics ────────────────────────────────────────

  validateHooks(_pluginRoot: string): DiagnosticResult[] {
    const results: DiagnosticResult[] = [];
    const settings = this.readSettings();

    if (!settings) {
      results.push({
        check: "Hook config",
        status: "fail",
        message: "No readable Qoder CLI settings found (checked ~/.qoder/settings.json, .qoder/settings.json, .qoder/settings.local.json)",
        fix: "context-mode upgrade",
      });
      return results;
    }

    const hooks = (settings.hooks ?? {}) as Record<string, QodercliHookEntry[]>;
    results.push({
      check: "Hook config",
      status: "pass",
      message: "Loaded Qoder CLI settings",
    });

    for (const hookType of REQUIRED_HOOKS) {
      const entries = hooks[hookType] ?? [];
      const hasHook = entries.some((e) => isQodercliContextModeHook(e, hookType));
      results.push({
        check: `${hookType} hook`,
        status: hasHook ? "pass" : "fail",
        message: hasHook
          ? `${hookType} hook configured`
          : `${hookType} hook not configured`,
        fix: hasHook ? undefined : "context-mode upgrade",
      });
    }

    for (const hookType of OPTIONAL_HOOKS) {
      const entries = hooks[hookType] ?? [];
      const hasHook = entries.some((e) => isQodercliContextModeHook(e, hookType));
      results.push({
        check: `${hookType} hook`,
        status: hasHook ? "pass" : "warn",
        message: hasHook
          ? `${hookType} hook configured`
          : `${hookType} hook missing — some features will be reduced`,
      });
    }

    return results;
  }

  checkPluginRegistration(): DiagnosticResult {
    try {
      const settings = this.readSettings();
      if (settings?.mcpServers && typeof settings.mcpServers === "object") {
        const servers = settings.mcpServers as Record<string, unknown>;
        if (Object.keys(servers).some(k => k.includes("context-mode"))) {
          return {
            check: "MCP registration",
            status: "pass",
            message: "context-mode found in mcpServers",
          };
        }
      }
      return {
        check: "MCP registration",
        status: "warn",
        message: "context-mode not found in Qoder CLI MCP config (~/.qoder/settings.json mcpServers)",
      };
    } catch {
      return {
        check: "MCP registration",
        status: "warn",
        message: "Could not read Qoder CLI settings",
      };
    }
  }

  getInstalledVersion(): string {
    return "standalone";
  }

  // ── Upgrade ────────────────────────────────────────────

  configureAllHooks(_pluginRoot: string): string[] {
    const settings = (this.readSettings() ?? {}) as Record<string, unknown>;
    const hooks = (settings.hooks ?? {}) as Record<string, QodercliHookEntry[]>;
    const changes: string[] = [];

    const hookSpecs: Array<[HookType, string | undefined]> = [
      [HOOK_TYPES.PRE_TOOL_USE, PRE_TOOL_USE_MATCHER_PATTERN],
      [HOOK_TYPES.POST_TOOL_USE, undefined],
      [HOOK_TYPES.USER_PROMPT_SUBMIT, undefined],
      [HOOK_TYPES.STOP, undefined],
    ];

    for (const [hookType, matcher] of hookSpecs) {
      const entries = hooks[hookType] ?? [];
      if (!entries.some((e) => isQodercliContextModeHook(e, hookType))) {
        const entry: QodercliHookEntry = {
          hooks: [{ type: "command", command: buildQodercliHookCommand(hookType) }],
        };
        if (matcher) entry.matcher = matcher;
        entries.push(entry);
        hooks[hookType] = entries;
        changes.push(`Added ${hookType} hook`);
      }
    }

    if (changes.length > 0) {
      settings.hooks = hooks;
      this.writeSettings(settings);
      changes.push(`Wrote hooks to ${this.getSettingsPath()}`);
    }
    return changes;
  }

  setHookPermissions(_pluginRoot: string): string[] {
    return [];
  }

  updatePluginRegistry(_pluginRoot: string, _version: string): void {
    // Qoder CLI has no plugin registry
  }

  // ── Private helpers ────────────────────────────────────

  private getCandidateSettingsPaths(): string[] {
    return [
      resolve(homedir(), ".qoder", "settings.json"),
      this.getSettingsPath(),
      resolve(".qoder", "settings.local.json"),
    ];
  }

  private getProjectDir(input: QodercliHookInput): string | undefined {
    return input.cwd || process.env.QODER_PROJECT_DIR || process.cwd();
  }

  private extractSessionId(input: QodercliHookInput): string {
    if (input.session_id) return input.session_id;
    if (input.transcript_path) {
      const match = input.transcript_path.match(
        /([a-f0-9-]{36})\.jsonl$/,
      );
      if (match) return match[1];
    }
    if (process.env.QODER_SESSION_ID) return process.env.QODER_SESSION_ID;
    return `pid-${process.ppid}`;
  }
}
