import { describe, expect, test } from "bun:test";
import { AGENT_PLATFORMS } from "./agent-platforms";
import {
  DEFAULT_OPENCODE_MODEL_PROVIDERS,
  DEFAULT_REASONING_ID,
  FALLBACK_REASONING_ID,
  MAX_OPENCODE_MODEL_PROVIDERS,
  fallbackReasoningId,
  isNativeAgentTabData,
  isSelectableOpenCodeModelId,
  isSelectableOpenCodeProvider,
  migrateOpenCodeModelProviders,
  normalizeOpenCodeModelProviders,
  openCodeModelDisplayLabel,
  openCodeModelLocalId,
  openCodeModelProviderId,
  openCodeModelProvidersKey,
  synthesizedOpenCodeAgentModel,
  nativeAgentCapabilities,
  resolveReasoningId,
  BACKGROUND_TASK_ID_MAX_LENGTH,
  BACKGROUND_TASK_LAUNCH_SCAN_CHARS,
  isBackgroundCapableShellTool,
  isBackgroundTaskLaunchCandidate,
  recoverBackgroundTaskLaunchId,
} from "./native-agent";

describe("native agent capability table", () => {
  test("answers every platform with an independent object", () => {
    for (const platform of AGENT_PLATFORMS) {
      const first = nativeAgentCapabilities(platform);
      const second = nativeAgentCapabilities(platform);
      expect(first).toEqual(second);
      // A shared table handed to two callers must not let one of them mutate
      // the other's view — the renderer and the backend both hold these.
      expect(first).not.toBe(second);
      expect(first.composer).not.toBe(second.composer);
      expect(first.attachments).not.toBe(second.attachments);
      first.queue = !first.queue;
      expect(nativeAgentCapabilities(platform).queue).toBe(second.queue);
    }
  });

  test("advertises queueing for every platform, including both ACP agents", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(nativeAgentCapabilities(platform).queue).toBe(true);
    }
  });

  test("publishes the provider differences the shared controller branches on", () => {
    expect(nativeAgentCapabilities("claude").backgroundTasks).toBe(true);
    expect(nativeAgentCapabilities("claude").composer.localSettings).toBe(true);
    expect(nativeAgentCapabilities("claude").composer.promptSuggestions).toBe(true);
    expect(nativeAgentCapabilities("claude").actions).toEqual({
      compact: true,
      rewindFiles: true,
    });

    expect(nativeAgentCapabilities("codex").attachments).toEqual({
      files: false,
      images: true,
    });
    expect(nativeAgentCapabilities("codex").actions).toEqual({
      compact: true,
      steer: true,
      review: true,
    });

    expect(nativeAgentCapabilities("opencode").composer.speed).toBe(false);
    // OpenCode's Build/Plan pair was a second execution-profile picker sent as
    // the SDK `agent` name, not a Claude/Codex permission mode.
    expect(nativeAgentCapabilities("opencode").composer.mode).toBe(false);
    expect(nativeAgentCapabilities("opencode").composer.executionProfile).toBe(true);

    // Only Claude reports execution profiles, local settings or prompt
    // suggestions today, and the projection is now gated on these rather than on
    // whether a provider happened to send them.
    for (const platform of ["codex", "cursor", "grok"] as const) {
      expect(nativeAgentCapabilities(platform).composer.executionProfile).toBe(false);
    }
    for (const platform of AGENT_PLATFORMS) {
      if (platform === "claude") continue;
      expect(nativeAgentCapabilities(platform).composer.localSettings).toBe(false);
      expect(nativeAgentCapabilities(platform).composer.promptSuggestions).toBe(false);
    }

    for (const platform of ["cursor", "grok"] as const) {
      // Both ACP agents read inline image content blocks; neither takes files.
      expect(nativeAgentCapabilities(platform).attachments).toEqual({
        files: false,
        images: true,
      });
      expect(nativeAgentCapabilities(platform).resume).toBe(true);
      expect(nativeAgentCapabilities(platform).fork).toBe(false);
      expect(nativeAgentCapabilities(platform).slashCommands).toBe(false);
      expect(nativeAgentCapabilities(platform).backgroundTasks).toBe(false);
      // Both are real ACP surfaces — Cursor drives fast through a config
      // option, Grok through a sibling `…-fast` model id, and both announce
      // session modes — so the table permits them and the live composer's
      // `fastModeAvailable` / `modes` decides per agent build.
      expect(nativeAgentCapabilities(platform).composer.speed).toBe(true);
      expect(nativeAgentCapabilities(platform).composer.mode).toBe(true);
      expect(nativeAgentCapabilities(platform).actions).toEqual({});
    }
  });
});

describe("opencode model provider allowlist", () => {
  test("defaults to the two managed catalogues", () => {
    expect([...DEFAULT_OPENCODE_MODEL_PROVIDERS]).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });

  test("falls back to the default pair when nothing is stored", () => {
    for (const value of [undefined, null, "opencode", {}, 5]) {
      expect(normalizeOpenCodeModelProviders(value)).toEqual([
        "opencode",
        "opencode-go",
      ]);
    }
  });

  test("preserves an explicitly empty list as unrestricted", () => {
    expect(normalizeOpenCodeModelProviders([])).toEqual([]);
    expect(isSelectableOpenCodeProvider("hpc-ai", [])).toBe(true);
  });

  test("falls back to the managed defaults for a nonempty unusable list", () => {
    for (const value of [[""], ["  ", null], [42, {}]]) {
      expect(normalizeOpenCodeModelProviders(value)).toEqual([
        "opencode",
        "opencode-go",
      ]);
    }
  });

  test("lowercases, trims, and dedupes stored ids", () => {
    expect(normalizeOpenCodeModelProviders([
      "  OpenCode ",
      "opencode",
      "OPENCODE-GO",
      "",
      42,
      "openrouter",
    ])).toEqual(["opencode", "opencode-go", "openrouter"]);
  });

  test("bounds the list so config cannot unbound a scan", () => {
    const providers = Array.from(
      { length: MAX_OPENCODE_MODEL_PROVIDERS + 20 },
      (_unused, index) => `provider-${index}`,
    );
    expect(normalizeOpenCodeModelProviders(providers)).toHaveLength(
      MAX_OPENCODE_MODEL_PROVIDERS,
    );
  });

  test("selects only the allowed providers", () => {
    const allowed = [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
    expect(isSelectableOpenCodeProvider("opencode", allowed)).toBe(true);
    expect(isSelectableOpenCodeProvider("opencode-go", allowed)).toBe(true);
    expect(isSelectableOpenCodeProvider("hpc-ai", allowed)).toBe(false);
    expect(isSelectableOpenCodeProvider("openrouter", allowed)).toBe(false);
  });

  test("reads the provider from the first segment only", () => {
    // OpenCode model halves may themselves contain slashes.
    expect(openCodeModelProviderId("opencode/claude-sonnet-5")).toBe("opencode");
    expect(openCodeModelProviderId("opencode-go/openai/gpt-5")).toBe("opencode-go");
    expect(openCodeModelProviderId("no-separator")).toBe("");
    expect(openCodeModelProviderId("/leading")).toBe("");
  });

  test("strips a duplicated provider prefix from the picker label", () => {
    expect(openCodeModelLocalId("opencode-go/deepseek-v4-flash"))
      .toBe("deepseek-v4-flash");
    expect(openCodeModelDisplayLabel(
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-flash",
    )).toBe("deepseek-v4-flash");
    expect(openCodeModelDisplayLabel(
      "opencode-go/deepseek-v4-pro",
      "DeepSeek V4 Pro",
    )).toBe("DeepSeek V4 Pro");
    expect(synthesizedOpenCodeAgentModel("opencode-go/deepseek-v4-flash")).toEqual({
      platform: "opencode",
      id: "opencode-go/deepseek-v4-flash",
      label: "deepseek-v4-flash",
      providerLabel: "opencode-go",
      reasoning: [{ id: "default", label: "Default" }],
      defaultReasoningId: "default",
      supportsSpeed: false,
      supportsMode: false,
    });
    expect(synthesizedOpenCodeAgentModel("not-a-model")).toBeNull();
  });

  test("strips the provider prefix regardless of its casing", () => {
    expect(openCodeModelDisplayLabel(
      "opencode-go/deepseek-v4-flash",
      "OpenCode-Go/deepseek-v4-flash",
    )).toBe("deepseek-v4-flash");
  });

  test("keeps every segment of a model half that contains slashes", () => {
    // The provider is only the first segment, so an OpenRouter-style id must
    // keep `anthropic/` — that belongs to the model, not the provider.
    expect(openCodeModelLocalId("openrouter/anthropic/claude-3.5"))
      .toBe("anthropic/claude-3.5");
    expect(openCodeModelDisplayLabel(
      "openrouter/anthropic/claude-3.5",
      "openrouter/anthropic/claude-3.5",
    )).toBe("anthropic/claude-3.5");
    expect(openCodeModelDisplayLabel("openrouter/anthropic/claude-3.5"))
      .toBe("anthropic/claude-3.5");
  });

  test("falls back to the model half when the reported name is unusable", () => {
    expect(openCodeModelDisplayLabel("opencode-go/deepseek-v4-flash", "   "))
      .toBe("deepseek-v4-flash");
    expect(openCodeModelDisplayLabel("opencode-go/deepseek-v4-flash", null))
      .toBe("deepseek-v4-flash");
    expect(openCodeModelDisplayLabel("opencode-go/deepseek-v4-flash", undefined))
      .toBe("deepseek-v4-flash");
    // A name that is exactly the prefix must never strip down to an empty label.
    expect(openCodeModelDisplayLabel("opencode-go/deepseek-v4-flash", "opencode-go/"))
      .toBe("deepseek-v4-flash");
    // An id with no provider half has nothing to strip.
    expect(openCodeModelDisplayLabel("no-separator")).toBe("no-separator");
  });

  test("selects model ids by their provider half", () => {
    const allowed = [...DEFAULT_OPENCODE_MODEL_PROVIDERS];
    expect(isSelectableOpenCodeModelId("opencode/claude-sonnet-5", allowed)).toBe(true);
    expect(isSelectableOpenCodeModelId("opencode-go/openai/gpt-5", allowed)).toBe(true);
    expect(isSelectableOpenCodeModelId("hpc-ai/kimi-k2.5", allowed)).toBe(false);
    // A bare model id names no provider and cannot be attributed to one.
    expect(isSelectableOpenCodeModelId("claude-sonnet-5", allowed)).toBe(false);
  });

  test("keys distinct allowlists distinctly", () => {
    expect(openCodeModelProvidersKey(["opencode", "opencode-go"]))
      .toBe(openCodeModelProvidersKey(["opencode", "opencode-go"]));
    expect(openCodeModelProvidersKey(["opencode"]))
      .not.toBe(openCodeModelProvidersKey(["opencode-go"]));
    // Nothing constrains a stored id's shape, so a separator-joined key would
    // serve one list's cached catalogue to the other.
    expect(openCodeModelProvidersKey(["a,b"]))
      .not.toBe(openCodeModelProvidersKey(["a", "b"]));
    // Order is part of the identity; re-filtering on a reorder is harmless.
    expect(openCodeModelProvidersKey(["a", "b"]))
      .not.toBe(openCodeModelProvidersKey(["b", "a"]));
  });
});

describe("opencode model provider migration", () => {
  test("returns the managed pair when no stored model names a provider", () => {
    expect(migrateOpenCodeModelProviders([
      "opencode/claude-sonnet-5",
      "claude-opus",
      "gpt-5.4",
      "default",
      undefined,
      null,
      42,
    ])).toEqual(["opencode", "opencode-go"]);
  });

  test("preserves providers a pre-existing install already selected from", () => {
    expect(migrateOpenCodeModelProviders([
      "openrouter/kimi-k2.5",
      "hpc-ai/deepseek",
      // A second model from an already-kept provider adds nothing.
      "openrouter/other",
      // Ids are matched lowercased, like a user-edited list.
      "  OpenRouter/Another  ",
    ])).toEqual(["opencode", "opencode-go", "openrouter", "hpc-ai"]);
  });

  test("bounds the migrated list by the same cap as a user-edited one", () => {
    const stored = Array.from(
      { length: MAX_OPENCODE_MODEL_PROVIDERS + 20 },
      (_unused, index) => `provider-${index}/model`,
    );
    expect(migrateOpenCodeModelProviders(stored)).toHaveLength(
      MAX_OPENCODE_MODEL_PROVIDERS,
    );
  });

  test("returns the managed pair for an install with nothing stored", () => {
    expect(migrateOpenCodeModelProviders([])).toEqual([
      "opencode",
      "opencode-go",
    ]);
  });
});

describe("native agent protocol", () => {
  test("accepts every provider through one tab-data contract", () => {
    for (const platform of AGENT_PLATFORMS) {
      expect(isNativeAgentTabData({
        platform,
        environmentId: "environment-1",
        sessionId: "session-1",
        hostPort: 4123,
        isLocal: true,
      })).toBe(true);
    }
  });

  test("rejects malformed persisted identities", () => {
    expect(isNativeAgentTabData({ platform: "other", environmentId: "env" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "" })).toBe(false);
    expect(isNativeAgentTabData({ platform: "codex", environmentId: "env", hostPort: 0 })).toBe(false);
  });

  test("rejects values that are not identity records at all", () => {
    for (const value of [undefined, null, "codex", 7, true, [], [{ platform: "codex" }]]) {
      expect(isNativeAgentTabData(value)).toBe(false);
    }
    expect(isNativeAgentTabData({ environmentId: "env" })).toBe(true);
    expect(isNativeAgentTabData({ platform: "codex" })).toBe(false);
  });

  test("rejects a host port that is not a usable TCP port", () => {
    const base = { platform: "codex", environmentId: "env" };
    for (const hostPort of [-1, 0, 1.5, NaN, Infinity, "4123", null, 2 ** 53]) {
      expect(isNativeAgentTabData({ ...base, hostPort })).toBe(false);
    }
    expect(isNativeAgentTabData({ ...base, hostPort: 1 })).toBe(true);
    expect(isNativeAgentTabData({ ...base, hostPort: 65535 })).toBe(true);
  });

  test("rejects optional fields of the wrong type", () => {
    const base = { platform: "codex", environmentId: "env" };
    expect(isNativeAgentTabData({ ...base, containerId: 1 })).toBe(false);
    expect(isNativeAgentTabData({ ...base, sessionId: {} })).toBe(false);
    expect(isNativeAgentTabData({ ...base, isLocal: "true" })).toBe(false);
  });

  test("accepts an identity whose optional fields are explicitly absent", () => {
    expect(isNativeAgentTabData({
      platform: "claude",
      environmentId: "env",
      containerId: undefined,
      hostPort: undefined,
      sessionId: undefined,
      isLocal: undefined,
    })).toBe(true);
  });
});

describe("fallbackReasoningId", () => {
  test("prefers an explicit default option over high", () => {
    expect(fallbackReasoningId(["default", "low", "high"])).toBe(DEFAULT_REASONING_ID);
    expect(fallbackReasoningId([{ id: "high" }, { id: "default" }])).toBe(DEFAULT_REASONING_ID);
  });

  test("prefers high when the catalog has no default option", () => {
    expect(fallbackReasoningId(["low", "medium", "high", "xhigh"])).toBe(FALLBACK_REASONING_ID);
  });

  test("falls back to the first option when neither default nor high exists", () => {
    expect(fallbackReasoningId(["medium"])).toBe("medium");
    expect(fallbackReasoningId(["fast", "deep"])).toBe("fast");
  });

  test("keeps an advertised default when high is not offered", () => {
    expect(fallbackReasoningId(["low", "medium", "xhigh"], "medium")).toBe("medium");
  });

  test("overrides an advertised medium default when high is offered", () => {
    expect(fallbackReasoningId(["low", "medium", "high"], "medium")).toBe(FALLBACK_REASONING_ID);
  });

  test("returns undefined for an empty catalog", () => {
    expect(fallbackReasoningId([])).toBeUndefined();
  });
});

describe("resolveReasoningId", () => {
  test("keeps a still-supported preference", () => {
    expect(resolveReasoningId(["low", "high"], "low")).toBe("low");
  });

  test("drops an unsupported preference and applies the fallback policy", () => {
    expect(resolveReasoningId(["low", "high"], "xhigh")).toBe(FALLBACK_REASONING_ID);
    expect(resolveReasoningId(["default", "fast"], "missing")).toBe(DEFAULT_REASONING_ID);
  });

  // The third argument is what separates a catalog whose own default must be
  // honoured (Cursor/Grok carry the agent's live effort there) from one where
  // the shared policy should win. Every caller that omits it silently degrades
  // to the first listed option, so pin the behaviour explicitly.
  test("falls back to the advertised default when neither default nor high is offered", () => {
    expect(resolveReasoningId(["low", "medium", "xhigh"], undefined, "medium")).toBe("medium");
    expect(resolveReasoningId(["low", "medium", "xhigh"], "max", "medium")).toBe("medium");
  });

  test("prefers high over an advertised default the catalog also offers", () => {
    expect(resolveReasoningId(["low", "medium", "high"], undefined, "medium"))
      .toBe(FALLBACK_REASONING_ID);
  });

  test("prefers an explicit default option over the advertised default", () => {
    expect(resolveReasoningId(["default", "low", "medium"], undefined, "medium"))
      .toBe(DEFAULT_REASONING_ID);
  });

  test("keeps a supported preference ahead of the advertised default", () => {
    expect(resolveReasoningId(["low", "medium", "xhigh"], "xhigh", "medium")).toBe("xhigh");
  });

  test("ignores an advertised default the catalog no longer offers", () => {
    expect(resolveReasoningId(["low", "medium"], undefined, "retired")).toBe("low");
  });

  test("returns undefined for an empty catalog even with a preference", () => {
    expect(resolveReasoningId([], "high", "medium")).toBeUndefined();
  });
});

describe("background task launch id recovery", () => {
  const shellRow = (toolOutput: string, toolArgs: Record<string, unknown> = {}) => ({
    toolName: "Bash",
    toolArgs,
    toolOutput,
  });

  test.each([
    [
      "an explicit background launch",
      "Command running in background with ID: bg-suite. Output is being written elsewhere.",
      { command: "bun test", run_in_background: true },
    ],
    [
      "a command the user backgrounded with Ctrl+B",
      "Command was manually backgrounded by user with ID: bg-dev",
      { command: "bun run dev" },
    ],
    [
      "a command a foreground timeout moved to the background",
      "Command exceeded its timeout and was moved to the background (ID: bg-build). Use BashOutput to read it.",
      { command: "bun run build" },
    ],
  ])("recovers the id from %s", (_case, output, args) => {
    expect(recoverBackgroundTaskLaunchId(shellRow(output, args))).toBe(
      output.includes("bg-suite")
        ? "bg-suite"
        : output.includes("bg-dev")
          ? "bg-dev"
          : "bg-build",
    );
  });

  test.each([
    ["backgroundTaskId", '{"backgroundTaskId":"bg-json"}'],
    ["task_id", '{"task_id":"bg-json"}'],
    ["taskId", '{"taskId":"bg-json"}'],
  ])("recovers a %s carried as a JSON body", (_key, output) => {
    expect(recoverBackgroundTaskLaunchId(shellRow(output))).toBe("bg-json");
  });

  test("refuses a row whose tool could not have backgrounded anything", () => {
    // The note is quoted verbatim in this repository's own source, so a Read of
    // it must not be mistaken for a launch and given a stop control.
    const read = {
      toolName: "Read",
      toolArgs: { file_path: "/repo/native-agent.ts" },
      toolOutput: "Command running in background with ID: bg-suite. …",
    };
    expect(isBackgroundTaskLaunchCandidate(read)).toBe(false);
    expect(recoverBackgroundTaskLaunchId(read)).toBeUndefined();
  });

  test("accepts a non-shell row that declared the launch in its arguments", () => {
    expect(isBackgroundTaskLaunchCandidate({
      toolName: "Task",
      toolArgs: { description: "Review", run_in_background: true },
    })).toBe(true);
  });

  test("treats a shell tool by any supported spelling", () => {
    for (const name of ["Bash", "bash", " SHELL ", "run_command", "run_terminal_cmd"]) {
      expect(isBackgroundCapableShellTool(name)).toBe(true);
    }
    for (const name of ["Read", "Task", "", undefined, 7, null]) {
      expect(isBackgroundCapableShellTool(name)).toBe(false);
    }
  });

  test("drops an id longer than the transport bound rather than carrying it", () => {
    const oversized = "x".repeat(BACKGROUND_TASK_ID_MAX_LENGTH + 1);
    expect(recoverBackgroundTaskLaunchId(
      shellRow(`Command running in background with ID: ${oversized}.`),
    )).toBeUndefined();
    const atLimit = "y".repeat(BACKGROUND_TASK_ID_MAX_LENGTH);
    expect(recoverBackgroundTaskLaunchId(
      shellRow(`Command running in background with ID: ${atLimit}.`),
    )).toBe(atLimit);
  });

  test("never parses a result larger than the scan bound as JSON", () => {
    // The regex scan is bounded by a slice; the JSON fallback has no such
    // option, so an oversized result must be refused outright rather than
    // parsed in full to decorate one transcript row.
    const padded = `{"task_id":"bg-json","noise":"${"z".repeat(BACKGROUND_TASK_LAUNCH_SCAN_CHARS)}"}`;
    expect(padded.length).toBeGreaterThan(BACKGROUND_TASK_LAUNCH_SCAN_CHARS);
    expect(recoverBackgroundTaskLaunchId(shellRow(padded))).toBeUndefined();
  });

  test("answers undefined for a row with no result at all", () => {
    expect(recoverBackgroundTaskLaunchId({ toolName: "Bash", toolArgs: {} }))
      .toBeUndefined();
    expect(recoverBackgroundTaskLaunchId({ toolName: "Bash", toolOutput: "" }))
      .toBeUndefined();
    expect(recoverBackgroundTaskLaunchId({ toolName: "Bash", toolOutput: 7 }))
      .toBeUndefined();
  });

  test("tolerates a malformed toolArgs without throwing", () => {
    expect(isBackgroundTaskLaunchCandidate({ toolName: "Read", toolArgs: [1, 2] }))
      .toBe(false);
    expect(isBackgroundTaskLaunchCandidate({ toolName: "Read", toolArgs: null }))
      .toBe(false);
  });
});
