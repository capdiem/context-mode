import "../setup-home";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { QodercliAdapter } from "../../src/adapters/qodercli/index.js";

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(process.cwd(), "tests", "fixtures", "qodercli", name), "utf-8"),
  ) as Record<string, unknown>;

describe("QodercliAdapter", () => {
  let adapter: QodercliAdapter;

  beforeEach(() => {
    adapter = new QodercliAdapter();
  });

  describe("capabilities", () => {
    it("enables PreToolUse + PostToolUse without SessionStart/PreCompact", () => {
      expect(adapter.capabilities.preToolUse).toBe(true);
      expect(adapter.capabilities.postToolUse).toBe(true);
      expect(adapter.capabilities.preCompact).toBe(false);
      expect(adapter.capabilities.sessionStart).toBe(false);
      expect(adapter.capabilities.canModifyArgs).toBe(true);
      expect(adapter.capabilities.canModifyOutput).toBe(false);
      expect(adapter.capabilities.canInjectSessionContext).toBe(true);
    });

    it("paradigm is json-stdio", () => {
      expect(adapter.paradigm).toBe("json-stdio");
    });

    it("name is Qoder CLI", () => {
      expect(adapter.name).toBe("Qoder CLI");
    });
  });

  describe("parsePreToolUseInput", () => {
    it("parses Bash tool fixture", () => {
      const event = adapter.parsePreToolUseInput(fixture("pretooluse-bash.json"));
      expect(event.toolName).toBe("Bash");
      expect(event.toolInput).toEqual({ command: "curl https://example.com/api" });
      expect(event.sessionId).toBe("qodercli-session-001");
      expect(event.projectDir).toBe("/tmp/qodercli-project");
    });

    it("extracts session_id from input", () => {
      const event = adapter.parsePreToolUseInput({
        session_id: "test-123",
        tool_name: "Read",
        tool_input: { file_path: "/tmp/file.txt" },
        cwd: "/project",
      });
      expect(event.sessionId).toBe("test-123");
    });

    it("falls back to QODER_SESSION_ID env var", () => {
      const orig = process.env.QODER_SESSION_ID;
      process.env.QODER_SESSION_ID = "env-session-456";
      try {
        const event = adapter.parsePreToolUseInput({
          tool_name: "Read",
          tool_input: {},
          cwd: "/project",
        });
        expect(event.sessionId).toBe("env-session-456");
      } finally {
        if (orig !== undefined) {
          process.env.QODER_SESSION_ID = orig;
        } else {
          delete process.env.QODER_SESSION_ID;
        }
      }
    });

    it("falls back to transcript_path UUID", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Read",
        tool_input: {},
        cwd: "/project",
        transcript_path: "/tmp/session-550e8400-e29b-41d4-a716-446655440000.jsonl",
      });
      expect(event.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("falls back to pid-based sessionId", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Read",
        tool_input: {},
        cwd: "/project",
      });
      expect(event.sessionId).toBe(`pid-${process.ppid}`);
    });

    it("uses cwd from input for projectDir", () => {
      const event = adapter.parsePreToolUseInput({
        tool_name: "Bash",
        tool_input: {},
        cwd: "/my/project",
      });
      expect(event.projectDir).toBe("/my/project");
    });

    it("falls back to QODER_PROJECT_DIR env for projectDir", () => {
      const orig = process.env.QODER_PROJECT_DIR;
      process.env.QODER_PROJECT_DIR = "/env/project";
      try {
        const event = adapter.parsePreToolUseInput({
          tool_name: "Bash",
          tool_input: {},
        });
        expect(event.projectDir).toBe("/env/project");
      } finally {
        if (orig !== undefined) {
          process.env.QODER_PROJECT_DIR = orig;
        } else {
          delete process.env.QODER_PROJECT_DIR;
        }
      }
    });
  });

  describe("parsePostToolUseInput", () => {
    it("parses tool output fixture", () => {
      const event = adapter.parsePostToolUseInput(fixture("posttooluse-bash.json"));
      expect(event.toolName).toBe("Bash");
      expect(event.toolOutput).toContain("package.json");
    });

    it("handles non-string tool_response", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Read",
        tool_input: {},
        tool_response: { content: "file contents" },
        cwd: "/project",
      });
      expect(event.toolOutput).toBe('{"content":"file contents"}');
    });

    it("returns empty string when tool_response is undefined", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Read",
        tool_input: {},
        cwd: "/project",
      });
      expect(event.toolOutput).toBe("");
    });

    it("returns empty string when tool_response is null", () => {
      const event = adapter.parsePostToolUseInput({
        tool_name: "Read",
        tool_input: {},
        tool_response: null,
        cwd: "/project",
      });
      expect(event.toolOutput).toBe("");
    });
  });

  describe("formatPreToolUseResponse", () => {
    it("formats deny with hookSpecificOutput + hookEventName", () => {
      expect(
        adapter.formatPreToolUseResponse({ decision: "deny", reason: "Blocked" }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Blocked",
        },
      });
    });

    it("formats ask with permissionDecision ask", () => {
      expect(adapter.formatPreToolUseResponse({ decision: "ask" })).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
        },
      });
    });

    it("formats modify with updatedInput", () => {
      const updatedInput = { file_path: "/new/path" };
      expect(
        adapter.formatPreToolUseResponse({ decision: "modify", updatedInput }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          updatedInput,
        },
      });
    });

    it("formats Bash redirect modify as deny with guidance", () => {
      expect(
        adapter.formatPreToolUseResponse({
          decision: "modify",
          updatedInput: { command: 'echo "Use ctx_execute instead"' },
        }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Use ctx_execute instead",
        },
      });
    });

    it("formats context with additionalContext", () => {
      expect(
        adapter.formatPreToolUseResponse({
          decision: "context",
          additionalContext: "Use sandbox tools.",
        }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "Use sandbox tools.",
        },
      });
    });

    it("returns undefined for allow", () => {
      expect(
        adapter.formatPreToolUseResponse({ decision: "allow" }),
      ).toBeUndefined();
    });
  });

  describe("formatPostToolUseResponse", () => {
    it("formats additionalContext with hookEventName", () => {
      expect(
        adapter.formatPostToolUseResponse({ additionalContext: "Captured." }),
      ).toEqual({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: "Captured.",
        },
      });
    });

    it("returns undefined when no context", () => {
      expect(adapter.formatPostToolUseResponse({})).toBeUndefined();
    });
  });

  describe("config paths", () => {
    it("settings path is .qoder/settings.json", () => {
      expect(adapter.getSettingsPath()).toBe(resolve(".qoder", "settings.json"));
    });

    it("config dir is ~/.qoder via BaseAdapter default", () => {
      expect(adapter.getConfigDir()).toBe(resolve(homedir(), ".qoder"));
    });

    it("session dir is under ~/.qoder/context-mode/sessions/", () => {
      expect(adapter.getSessionDir()).toBe(
        join(homedir(), ".qoder", "context-mode", "sessions"),
      );
    });

    it("instruction files returns QODER.md and AGENTS.md", () => {
      expect(adapter.getInstructionFiles()).toEqual(["AGENTS.md", "QODER.md"]);
    });
  });

  describe("hook config management", () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = mkdtempSync(join(tmpdir(), "qodercli-adapter-test-"));
      Object.defineProperty(adapter, "getSettingsPath", {
        value: () => join(tempDir, "settings.json"),
        configurable: true,
      });
    });

    afterEach(() => {
      rmSync(tempDir, { recursive: true, force: true });
    });

    it("generates hook config for 4 events", () => {
      const config = adapter.generateHookConfig("/plugin/root") as Record<string, unknown>;
      expect(Object.keys(config).sort()).toEqual([
        "PostToolUse",
        "PreToolUse",
        "Stop",
        "UserPromptSubmit",
      ]);
    });

    it("configureAllHooks writes settings.json with hooks", () => {
      const changes = adapter.configureAllHooks("/plugin/root");
      const written = JSON.parse(
        readFileSync(join(tempDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;

      expect(changes.length).toBeGreaterThan(0);
      expect(written.hooks).toBeTruthy();

      const hooks = written.hooks as Record<string, Array<Record<string, unknown>>>;
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.Stop).toBeDefined();
      expect(hooks.UserPromptSubmit).toBeDefined();

      const preEntry = hooks.PreToolUse[0] as Record<string, unknown>;
      expect(String(preEntry.matcher)).toContain("Bash");
    });

    it("configureAllHooks is idempotent and skips write when no changes", () => {
      const firstChanges = adapter.configureAllHooks("/plugin/root");
      const first = readFileSync(join(tempDir, "settings.json"), "utf-8");
      const secondChanges = adapter.configureAllHooks("/plugin/root");
      const second = readFileSync(join(tempDir, "settings.json"), "utf-8");
      expect(first).toBe(second);
      expect(firstChanges.length).toBeGreaterThan(0);
      expect(secondChanges).toEqual([]);
    });

    it("validateHooks passes when hooks configured", () => {
      adapter.configureAllHooks("/plugin/root");
      const results = adapter.validateHooks("/plugin/root");
      const preResult = results.find((r) => r.check === "PreToolUse hook");
      expect(preResult?.status).toBe("pass");
    });

    it("validateHooks fails when no settings", () => {
      const results = adapter.validateHooks("/plugin/root");
      expect(results[0]?.status).toBe("fail");
    });

    it("readSettings merges hooks from multiple config files", () => {
      mkdirSync(join(tempDir, "..", ".qoder"), { recursive: true });
      const userSettings = join(tempDir, "..", ".qoder", "settings.json");
      writeFileSync(userSettings, JSON.stringify({
        hooks: {
          PreToolUse: [{
            matcher: "Bash",
            hooks: [{ type: "command", command: "user-hook.sh" }],
          }],
        },
      }));
      writeFileSync(join(tempDir, "settings.json"), JSON.stringify({
        hooks: {
          PostToolUse: [{
            hooks: [{ type: "command", command: "project-hook.sh" }],
          }],
        },
      }));
    });
  });

  describe("config templates (configs/qodercli/)", () => {
    const configsDir = resolve(process.cwd(), "configs", "qodercli");

    it("mcp.json has correct MCP server structure", () => {
      const mcp = JSON.parse(
        readFileSync(join(configsDir, "mcp.json"), "utf-8"),
      ) as Record<string, unknown>;
      const servers = mcp.mcpServers as Record<string, unknown>;
      expect(servers).toBeDefined();
      expect(servers["context-mode"]).toBeDefined();
      expect((servers["context-mode"] as Record<string, unknown>).command).toBe("context-mode");
    });

    it("settings.json template has all 4 hook event types", () => {
      const settings = JSON.parse(
        readFileSync(join(configsDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
      expect(hooks).toBeDefined();
      expect(hooks.PreToolUse).toBeDefined();
      expect(hooks.PostToolUse).toBeDefined();
      expect(hooks.UserPromptSubmit).toBeDefined();
      expect(hooks.Stop).toBeDefined();
    });

    it("settings.json PreToolUse has matcher pattern with Bash", () => {
      const settings = JSON.parse(
        readFileSync(join(configsDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
      const preEntry = hooks.PreToolUse[0] as Record<string, unknown>;
      expect(String(preEntry.matcher)).toContain("Bash");
    });

    it("settings.json template is consistent with generateHookConfig output", () => {
      const settings = JSON.parse(
        readFileSync(join(configsDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const templateHooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
      const generated = adapter.generateHookConfig("/plugin/root") as Record<string, unknown>;
      const generatedHooks = generated as Record<string, Array<Record<string, unknown>>>;

      expect(Object.keys(templateHooks).sort()).toEqual(
        Object.keys(generatedHooks).sort(),
      );

      const templatePre = templateHooks.PreToolUse[0] as Record<string, unknown>;
      const generatedPre = generatedHooks.PreToolUse[0] as Record<string, unknown>;
      expect(templatePre.matcher).toBe(generatedPre.matcher);
    });

    it("all hook commands reference context-mode hook qodercli", () => {
      const settings = JSON.parse(
        readFileSync(join(configsDir, "settings.json"), "utf-8"),
      ) as Record<string, unknown>;
      const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
      for (const [, entries] of Object.entries(hooks)) {
        for (const entry of entries) {
          const hookEntries = entry.hooks as Array<Record<string, unknown>>;
          for (const hook of hookEntries) {
            expect(String(hook.command)).toMatch(/^context-mode hook qodercli /);
            expect(String(hook.type)).toBe("command");
          }
        }
      }
    });
  });

  describe("stop hook", () => {
    it("has no dedicated parseStopInput by default — uses session_id from input", () => {
      const event = adapter.parsePreToolUseInput({
        session_id: "stop-session-1",
        tool_name: "",
        tool_input: {},
        cwd: "/project",
      });
      expect(event.sessionId).toBe("stop-session-1");
    });
  });

  describe("checkPluginRegistration", () => {
    it("returns warn when no settings exist", () => {
      const result = adapter.checkPluginRegistration();
      expect(result.status).toBe("warn");
    });
  });
});
