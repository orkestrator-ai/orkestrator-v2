import { describe, expect, test } from "bun:test";

import { parseAgentTestArguments, parseDevArguments } from "./arguments.js";

describe("development CLI arguments", () => {
  test("enables every supported provider for agent testing by default", () => {
    expect(parseAgentTestArguments(["--fixture"]).credentialSources)
      .toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
  });

  test("keeps ordinary development credential-free by default", () => {
    expect(parseDevArguments(["--fixture"]).credentialSources).toEqual([]);
  });

  test("keeps an explicitly narrowed provider list", () => {
    expect(parseAgentTestArguments([
      "--credential-source", "codex",
      "--credential-source", "codex",
    ]).credentialSources).toEqual(["codex"]);
    expect(parseAgentTestArguments([
      "--credential-source", "cursor",
      "--credential-source", "grok",
    ]).credentialSources).toEqual(["cursor", "grok"]);
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

  test("provisions every agent platform for agent testing by default", () => {
    // Cursor and Grok resolve only through the managed toolchain, so an empty
    // default is what made them untestable in an isolated profile.
    expect(parseAgentTestArguments(["--fixture"]).agentPlatforms)
      .toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
  });

  test("leaves ordinary development to its durable platform selection", () => {
    expect(parseDevArguments(["--fixture"]).agentPlatforms).toEqual([]);
  });

  test("keeps an explicitly narrowed platform list", () => {
    expect(parseAgentTestArguments([
      "--agent-platforms", "cursor,grok,cursor",
    ]).agentPlatforms).toEqual(["cursor", "grok"]);
  });

  test("still provisions platforms for a credential-free agent-test profile", () => {
    // Credentials and toolchains are independent: a profile can legitimately
    // launch an agent with no login to check its unauthenticated path.
    expect(parseAgentTestArguments(["--no-agent-credentials"]).agentPlatforms)
      .toEqual(["claude", "codex", "cursor", "grok", "opencode"]);
  });

  test("rejects an unknown agent platform", () => {
    expect(() => parseAgentTestArguments(["--agent-platforms", "cursor,nope"]))
      .toThrow("--agent-platforms accepts");
  });

  test("rejects --agent-platforms outside dev:test rather than ignoring it", () => {
    // Only the agent-test flavor reads a platform selection. Accepting it here
    // validated the value, wrote it into the profile, and then did nothing with
    // it — the flag looked supported and silently was not.
    expect(() => parseDevArguments(["--agent-platforms", "cursor"]))
      .toThrow("only supported by bun run dev:test");
  });
});
