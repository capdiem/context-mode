/**
 * adapters/qodercli — Qoder CLI platform adapter hooks.
 */

export const HOOK_TYPES = {
  PRE_TOOL_USE: "PreToolUse",
  POST_TOOL_USE: "PostToolUse",
  USER_PROMPT_SUBMIT: "UserPromptSubmit",
  STOP: "Stop",
} as const;

export type HookType = (typeof HOOK_TYPES)[keyof typeof HOOK_TYPES];

export const HOOK_SCRIPTS: Record<HookType, string> = {
  [HOOK_TYPES.PRE_TOOL_USE]: "pretooluse.mjs",
  [HOOK_TYPES.POST_TOOL_USE]: "posttooluse.mjs",
  [HOOK_TYPES.USER_PROMPT_SUBMIT]: "userpromptsubmit.mjs",
  [HOOK_TYPES.STOP]: "stop.mjs",
};

export const PRE_TOOL_USE_MATCHERS = [
  "Bash",
  "Read",
  "Grep",
  "WebFetch",
  "Task",
  "mcp__",
] as const;

export const PRE_TOOL_USE_MATCHER_PATTERN = PRE_TOOL_USE_MATCHERS.join("|");

export const REQUIRED_HOOKS: HookType[] = [
  HOOK_TYPES.PRE_TOOL_USE,
];

export const OPTIONAL_HOOKS: HookType[] = [
  HOOK_TYPES.POST_TOOL_USE,
  HOOK_TYPES.STOP,
  HOOK_TYPES.USER_PROMPT_SUBMIT,
];

export interface QodercliHookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command: string; timeout?: number }>;
}

export function isContextModeHook(
  entry: QodercliHookEntry,
  hookType: HookType,
): boolean {
  const expectedSuffix = `qodercli ${hookType.toLowerCase()}`;
  return entry.hooks?.some((hook) => {
    const cmd = hook.command ?? "";
    return cmd.includes("context-mode") && cmd.includes(expectedSuffix);
  }) ?? false;
}

export function buildHookCommand(hookType: HookType): string {
  return `context-mode hook qodercli ${hookType.toLowerCase()}`;
}
