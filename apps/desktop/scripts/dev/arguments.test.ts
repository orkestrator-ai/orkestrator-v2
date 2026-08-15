import { describe, expect, test } from "bun:test";

import { applyAgentTestDefaults, parseDevArguments } from "./arguments.js";

describe("development CLI arguments", () => {
  test("enables every supported provider for agent testing by default", () => {
    expect(applyAgentTestDefaults(parseDevArguments(["--fixture"])).credentialSources)
      .toEqual(["claude", "codex", "opencode"]);
  });

  test("keeps an explicitly narrowed provider list", () => {
    expect(applyAgentTestDefaults(parseDevArguments([
      "--credential-source", "codex",
      "--credential-source", "codex",
    ])).credentialSources).toEqual(["codex"]);
  });

  test("supports an explicitly credential-free agent-test profile", () => {
    const parsed = applyAgentTestDefaults(parseDevArguments(["--no-agent-credentials"]));
    expect(parsed.agentCredentialsDisabled).toBe(true);
    expect(parsed.credentialSources).toEqual([]);
  });

  test("rejects contradictory credential flags", () => {
    expect(() => parseDevArguments([
      "--no-agent-credentials",
      "--credential-source", "claude",
    ])).toThrow("cannot be combined");
  });
});
