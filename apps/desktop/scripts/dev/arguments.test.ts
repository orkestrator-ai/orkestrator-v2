import { describe, expect, test } from "bun:test";

import { parseAgentTestArguments, parseDevArguments } from "./arguments.js";

describe("development CLI arguments", () => {
  test("enables every supported provider for agent testing by default", () => {
    expect(parseAgentTestArguments(["--fixture"]).credentialSources)
      .toEqual(["claude", "codex", "opencode"]);
  });

  test("keeps ordinary development credential-free by default", () => {
    expect(parseDevArguments(["--fixture"]).credentialSources).toEqual([]);
  });

  test("keeps an explicitly narrowed provider list", () => {
    expect(parseAgentTestArguments([
      "--credential-source", "codex",
      "--credential-source", "codex",
    ]).credentialSources).toEqual(["codex"]);
  });

  test("supports an explicitly credential-free agent-test profile", () => {
    const parsed = parseAgentTestArguments(["--no-agent-credentials"]);
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
