import { describe, expect, test } from "bun:test";
import { resolveClaudeConfig } from "./claude-mode-resolver";
import type { GlobalConfig, RepositoryConfig } from "@/types";

const globalConfig = {
  claudeMode: "terminal",
  claudeNativeBackend: "sdk",
} as GlobalConfig;

describe("resolveClaudeConfig", () => {
  test("falls back to global mode and backend", () => {
    expect(resolveClaudeConfig(globalConfig, undefined, undefined)).toEqual({
      mode: "terminal",
      nativeBackend: "sdk",
    });
  });

  test("uses repository agent style and backend over global defaults", () => {
    const repo = {
      agentStyle: "native",
      claudeNativeBackend: "tmux",
    } as RepositoryConfig;

    expect(resolveClaudeConfig(globalConfig, repo, undefined)).toEqual({
      mode: "native",
      nativeBackend: "tmux",
    });
  });

  test("environment overrides win over repository settings", () => {
    const repo = {
      agentStyle: "native",
      claudeNativeBackend: "tmux",
    } as RepositoryConfig;

    expect(
      resolveClaudeConfig(globalConfig, repo, {
        claudeMode: "terminal",
        claudeNativeBackend: "sdk",
      }),
    ).toEqual({
      mode: "terminal",
      nativeBackend: "sdk",
    });
  });
});
