import { describe, expect, test } from "bun:test";

import { parseAgentTestArguments, parseDevArguments } from "./arguments.js";

describe("development CLI arguments", () => {
  test("enables every supported provider for agent testing by default", () => {
    expect(parseAgentTestArguments(["--fixture"]).credentialSources).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  test("keeps ordinary development credential-free by default", () => {
    expect(parseDevArguments(["--fixture"]).credentialSources).toEqual([]);
  });

  test("keeps an explicitly narrowed provider list", () => {
    expect(
      parseAgentTestArguments(["--credential-source", "codex", "--credential-source", "codex"])
        .credentialSources,
    ).toEqual(["codex"]);
    expect(
      parseAgentTestArguments(["--credential-source", "cursor", "--credential-source", "grok"])
        .credentialSources,
    ).toEqual(["cursor", "grok"]);
  });

  test("supports an explicitly credential-free agent-test profile", () => {
    const parsed = parseAgentTestArguments(["--no-agent-credentials"]);
    expect(parsed.agentCredentialsDisabled).toBe(true);
    expect(parsed.credentialSources).toEqual([]);
  });

  test("rejects contradictory credential flags", () => {
    expect(() =>
      parseDevArguments(["--no-agent-credentials", "--credential-source", "claude"]),
    ).toThrow("cannot be combined");
  });

  test("provisions every agent platform for agent testing by default", () => {
    // Cursor and Grok resolve only through the managed toolchain, so an empty
    // default is what made them untestable in an isolated profile.
    expect(parseAgentTestArguments(["--fixture"]).agentPlatforms).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  test("leaves ordinary development to its durable platform selection", () => {
    expect(parseDevArguments(["--fixture"]).agentPlatforms).toEqual([]);
  });

  test("keeps an explicitly narrowed platform list", () => {
    expect(
      parseAgentTestArguments(["--agent-platforms", "cursor,grok,cursor"]).agentPlatforms,
    ).toEqual(["cursor", "grok"]);
  });

  test("still provisions platforms for a credential-free agent-test profile", () => {
    // Credentials and toolchains are independent: a profile can legitimately
    // launch an agent with no login to check its unauthenticated path.
    expect(parseAgentTestArguments(["--no-agent-credentials"]).agentPlatforms).toEqual([
      "claude",
      "codex",
      "cursor",
      "grok",
      "opencode",
      "pi",
    ]);
  });

  test("rejects an unknown agent platform", () => {
    expect(() => parseAgentTestArguments(["--agent-platforms", "cursor,nope"])).toThrow(
      "--agent-platforms accepts",
    );
  });

  test("rejects --agent-platforms outside dev:test rather than ignoring it", () => {
    // Only the agent-test flavor reads a platform selection. Accepting it here
    // validated the value, wrote it into the profile, and then did nothing with
    // it — the flag looked supported and silently was not.
    expect(() => parseDevArguments(["--agent-platforms", "cursor"])).toThrow(
      "only supported by mise run dev:test",
    );
  });

  test("selects the fixture container's network mode only with a container fixture", () => {
    expect(
      parseAgentTestArguments(["--fixture-environments", "local,container"])
        .fixtureContainerNetwork,
    ).toBeUndefined();
    expect(
      parseAgentTestArguments([
        "--fixture-environments",
        "local,container",
        "--fixture-network",
        "full",
      ]).fixtureContainerNetwork,
    ).toBe("full");
    expect(() =>
      parseAgentTestArguments(["--fixture-environments", "container", "--fixture-network", "open"]),
    ).toThrow("--fixture-network accepts restricted or full");
    expect(() => parseAgentTestArguments(["--fixture", "--fixture-network", "full"])).toThrow(
      "--fixture-network needs --fixture-environments with container",
    );
  });

  test("only dev:test opts into the configured dev worktree folder", () => {
    expect(parseAgentTestArguments(["--fixture"]).useDevWorktreeFolder).toBeUndefined();
    expect(parseAgentTestArguments(["--use-dev-worktree-folder"]).useDevWorktreeFolder).toBe(true);
    expect(() => parseDevArguments(["--use-dev-worktree-folder"])).toThrow(
      "only supported by mise run dev:test",
    );
  });

  test("only dev:test can start without reading the host installation", () => {
    expect(parseAgentTestArguments(["--fixture"]).hostSeedDisabled).toBeUndefined();
    expect(parseAgentTestArguments(["--no-host-seed"]).hostSeedDisabled).toBe(true);
    // `--host-seed` clears an opt-out the profile recorded on an earlier start.
    expect(parseAgentTestArguments(["--host-seed"]).hostSeedDisabled).toBe(false);
    expect(() => parseAgentTestArguments(["--host-seed", "--no-host-seed"])).toThrow(
      "cannot be combined",
    );
    for (const flag of ["--no-host-seed", "--host-seed"]) {
      expect(() => parseDevArguments([flag])).toThrow("only supported by mise run dev:test");
    }
  });

  test("only dev:test runs Electron headless", () => {
    expect(parseAgentTestArguments(["--fixture"]).headless).toBeUndefined();
    expect(parseAgentTestArguments(["--headless"]).headless).toBe(true);
    expect(parseAgentTestArguments(["--no-headless"]).headless).toBe(false);
    // The earlier spelling keeps working for scripts and notes that use it.
    expect(parseAgentTestArguments(["--headless-electron"]).headless).toBe(true);
    for (const flag of ["--headless", "--headless-electron", "--no-headless"]) {
      expect(() => parseDevArguments([flag])).toThrow("only supported by mise run dev:test");
    }
  });

  test("refuses contradictory headless flags in either order", () => {
    expect(() => parseAgentTestArguments(["--headless", "--no-headless"])).toThrow(
      "cannot be combined",
    );
    expect(() => parseAgentTestArguments(["--no-headless", "--headless-electron"])).toThrow(
      "cannot be combined",
    );
    expect(parseAgentTestArguments(["--headless", "--headless"]).headless).toBe(true);
  });
});
