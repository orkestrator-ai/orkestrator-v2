import { describe, expect, test } from "bun:test";
import type { ClaudeModel } from "@/lib/claude-client";
import { FALLBACK_CLAUDE_MODELS } from "@/lib/claude-fallback-models";
import { firstModelFor, type AgentModelCatalog } from "@/lib/agent-launch";
import {
  DEFAULT_MODEL,
  TMUX_FALLBACK_MODELS,
  resolveTmuxModelPreference,
  tmuxModelIsAvailable,
} from "./ClaudeTmuxChatTab.parts";

describe("tmux Claude model preferences", () => {
  test("uses the renderer's single fallback catalogue", () => {
    expect(TMUX_FALLBACK_MODELS).toBe(FALLBACK_CLAUDE_MODELS);
  });

  test("maps Opus 5.5 concrete ids onto the catalogue's aliases", () => {
    expect(resolveTmuxModelPreference("claude-opus-5-5", TMUX_FALLBACK_MODELS)).toBe(DEFAULT_MODEL);
    expect(resolveTmuxModelPreference("claude-opus-5-5[1m]", TMUX_FALLBACK_MODELS)).toBe(
      "opus[1m]",
    );
    expect(tmuxModelIsAvailable("claude-opus-5-5[1m]", TMUX_FALLBACK_MODELS)).toBe(true);
  });

  test("still maps the previous Opus ids", () => {
    expect(resolveTmuxModelPreference("claude-opus-5", TMUX_FALLBACK_MODELS)).toBe(DEFAULT_MODEL);
    expect(resolveTmuxModelPreference("claude-opus-5[1m]", TMUX_FALLBACK_MODELS)).toBe("opus[1m]");
  });

  test("upgrades a saved Fable 5 selection to Fable 5.1", () => {
    expect(resolveTmuxModelPreference("claude-fable-5", TMUX_FALLBACK_MODELS)).toBe(
      "claude-fable-5-1[1m]",
    );
    expect(resolveTmuxModelPreference("claude-fable-5[1m]", TMUX_FALLBACK_MODELS)).toBe(
      "claude-fable-5-1[1m]",
    );
    const launchCatalog: AgentModelCatalog = {
      claude: FALLBACK_CLAUDE_MODELS.map((model) => ({
        ...model,
        reasoningEfforts: model.supportedEffortLevels ?? [],
      })),
      codex: [],
      opencode: [],
    };
    expect(resolveTmuxModelPreference("claude-fable-5", TMUX_FALLBACK_MODELS)).toBe(
      firstModelFor("claude", launchCatalog, { claude: "claude-fable-5" }),
    );
  });

  test("keeps an id the catalogue still offers instead of remapping it", () => {
    // An environment on an older Claude Code still reports Fable 5; the
    // legacy mapping must not steer that choice to a model it cannot run.
    const older: ClaudeModel[] = [
      { id: "default", name: "Default (recommended)" },
      { id: "claude-fable-5[1m]", name: "Fable" },
    ];
    expect(resolveTmuxModelPreference("claude-fable-5[1m]", older)).toBe("claude-fable-5[1m]");
    expect(tmuxModelIsAvailable("claude-fable-5[1m]", older)).toBe(true);
  });

  test("falls back to the default for an unknown or missing id", () => {
    expect(resolveTmuxModelPreference("claude-unknown", TMUX_FALLBACK_MODELS)).toBe(DEFAULT_MODEL);
    expect(resolveTmuxModelPreference(undefined, TMUX_FALLBACK_MODELS)).toBe(DEFAULT_MODEL);
    expect(tmuxModelIsAvailable("claude-unknown", TMUX_FALLBACK_MODELS)).toBe(false);
  });
});
