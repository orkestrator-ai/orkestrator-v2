import { describe, expect, test } from "bun:test";
import { resolveDefaultReviewTabType } from "./review-launch-options";
import { useConfigStore } from "@/stores/configStore";

describe("resolveDefaultReviewTabType", () => {
  const global = useConfigStore.getState().config.global;

  test("resolves Claude SDK, tmux, and terminal defaults", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "sdk" },
      global,
    })).toBe("claude-native");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "native", claudeNativeBackend: "tmux" },
      global,
    })).toBe("claude-tmux");

    expect(resolveDefaultReviewTabType({
      defaultAgent: "claude",
      environment: { claudeMode: "terminal" },
      global,
    })).toBe("claude-cli");
  });

  test("resolves Codex and OpenCode modes", () => {
    expect(resolveDefaultReviewTabType({
      defaultAgent: "codex",
      environment: { codexMode: "native" },
      global,
    })).toBe("codex-native");
    expect(resolveDefaultReviewTabType({
      defaultAgent: "opencode",
      environment: { opencodeMode: "terminal" },
      global,
    })).toBe("opencode-cli");
  });
});
