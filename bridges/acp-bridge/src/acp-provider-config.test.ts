import { describe, expect, test } from "bun:test";
import {
  loadAcpProviderConfig,
  providerArgv,
  providerEnv,
  undeclaredPromptCapabilities,
} from "./acp-provider-config.js";

describe("ACP provider configuration", () => {
  test("loads Grok from the built-in launcher record", () => {
    const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
    expect(config).toMatchObject({
      id: "grok",
      executable: "/bin/grok",
      requiresAuthenticate: true,
      modeMap: { agent: "build", plan: "plan" },
    });
    expect(providerArgv(config, { model: "grok-code", effort: "high" })).toEqual([
      "--always-approve",
      "agent",
      "--model",
      "grok-code",
      "--reasoning-effort",
      "high",
      "stdio",
    ]);
  });

  test("switches Grok's web tools off when the network is denied", () => {
    const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
    // `--disable-web-search` is top-level; `--no-leader` belongs to `agent`, and
    // keeps a configured shared leader (which ignores the flag) out of the way.
    expect(
      providerArgv(config, {
        model: "grok-code",
        effort: "high",
        approvals: "deny",
        denyNetwork: true,
      }),
    ).toEqual([
      "--disable-web-search",
      "agent",
      "--no-leader",
      "--model",
      "grok-code",
      "--reasoning-effort",
      "high",
      "stdio",
    ]);
    expect(providerArgv(config, { denyNetwork: false })).not.toContain("--disable-web-search");
  });

  test("keys the network flags by provider id, so the backend's record cannot drop them", () => {
    // The backend serializes its own Grok record into ACP_PROVIDER_CONFIG, which
    // replaces the built-in one; the flags must not depend on that record.
    const serialized = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({
        id: "grok",
        executable: "grok",
        argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
      }),
    });
    expect(providerArgv(serialized, { approvals: "deny", denyNetwork: true })).toEqual([
      "--disable-web-search",
      "agent",
      "--no-leader",
      "stdio",
    ]);

    // A provider this bridge knows no flag for is left as configured: it has no
    // tool to switch off that the bridge could name.
    const generic = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({ id: "gemini", executable: "gemini", argv: ["--acp"] }),
    });
    expect(providerArgv(generic, { denyNetwork: true })).toEqual(["--acp"]);
  });

  test("trusts the checkout for Grok only when project resources are on", () => {
    const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
    // Grok skips an untrusted git checkout's AGENTS.md, skills and commands.
    // The gate is turned off for this child only; a shared leader would decide
    // trust in its own process, so it is kept out of the way.
    expect(providerEnv(config, { trustProject: true }, { HOME: "/home/u" })).toEqual({
      HOME: "/home/u",
      GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "false",
      GROK_FOLDER_TRUST: "0",
    });
    expect(providerArgv(config, { trustProject: true })).toEqual([
      "--always-approve",
      "agent",
      "--no-leader",
      "stdio",
    ]);

    // Off, Grok keeps its own gate, and a user's own setting is left alone.
    expect(providerEnv(config, { trustProject: false }, { GROK_FOLDER_TRUST: "1" })).toEqual({
      GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "false",
      GROK_FOLDER_TRUST: "1",
    });
    expect(providerArgv(config, { trustProject: false })).not.toContain("--no-leader");

    // With network denial as well, the shared `--no-leader` appears once.
    expect(
      providerArgv(config, { approvals: "deny", denyNetwork: true, trustProject: true }),
    ).toEqual(["--disable-web-search", "agent", "--no-leader", "stdio"]);

    // Keyed by provider id: the backend's serialized record cannot drop it, and
    // an agent this bridge knows no trust switch for is left as configured.
    const serialized = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({ id: "grok", executable: "grok", argv: ["agent"] }),
    });
    expect(providerEnv(serialized, { trustProject: true }, {}).GROK_FOLDER_TRUST).toBe("0");
    const generic = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({ id: "gemini", executable: "gemini", argv: ["--acp"] }),
    });
    expect(providerEnv(generic, { trustProject: true }, {})).toEqual({});
    expect(providerArgv(generic, { trustProject: true })).toEqual(["--acp"]);
  });

  test("loads a generic ACP agent entirely from a config record", () => {
    const config = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({
        id: "gemini",
        name: "Gemini CLI",
        executable: "/opt/gemini",
        argv: ["--acp"],
        env: { SAFE_MODE: "1" },
        requiresAuthenticate: false,
        modeMap: { auto: "build" },
        extensionPrefixes: ["gemini/"],
        acknowledgedExtensionMethods: ["gemini/status"],
        modelUpdateMethods: [],
        sessionUpdateMethods: [],
      }),
    });
    expect(config).toMatchObject({
      id: "gemini",
      executable: "/opt/gemini",
      argv: ["--acp"],
      env: { SAFE_MODE: "1" },
      extensionPrefixes: ["gemini/"],
    });
  });

  test("does not fall back to an executable for an unregistered provider", () => {
    expect(() => loadAcpProviderConfig({ ACP_PROVIDER: "gemini" })).toThrow(
      "ACP_PROVIDER_CONFIG is required",
    );
  });

  test("does not retain Cursor as a built-in ACP provider", () => {
    expect(() =>
      loadAcpProviderConfig({ ACP_PROVIDER: "cursor", ACP_AGENT_PATH: "/bin/cursor-agent" }),
    ).toThrow("ACP_PROVIDER_CONFIG is required");
  });

  test("credits no provider with prompt content it does not declare", () => {
    // Grok 1.0.67 declares `promptCapabilities.image: true` itself, so its
    // 1.0.52 entry is gone: the agent's own answer decides.
    expect(undeclaredPromptCapabilities("grok")).toEqual({});
    expect(undeclaredPromptCapabilities("cursor")).toEqual({});
    expect(undeclaredPromptCapabilities("toString")).toEqual({});
  });

  test("keeps Grok from inheriting the main checkout's saved approvals", () => {
    // A TUI "always allow" in the user's main checkout would otherwise run a
    // tool in this worktree without the permission request the bridge answers
    // from the execution policy. Forced over the launcher record and the
    // inherited environment, so neither can turn the inheritance back on.
    const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok", ACP_AGENT_PATH: "/bin/grok" });
    for (const trustProject of [false, true]) {
      expect(
        providerEnv(config, { trustProject }, { GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "true" })
          .GROK_WORKTREE_INHERITS_MAIN_APPROVALS,
      ).toBe("false");
    }
    const serialized = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({
        id: "grok",
        executable: "grok",
        argv: ["agent"],
        env: { GROK_WORKTREE_INHERITS_MAIN_APPROVALS: "true" },
      }),
    });
    expect(providerEnv(serialized, {}, {}).GROK_WORKTREE_INHERITS_MAIN_APPROVALS).toBe("false");
    const generic = loadAcpProviderConfig({
      ACP_PROVIDER_CONFIG: JSON.stringify({ id: "gemini", executable: "gemini", argv: ["--acp"] }),
    });
    expect(providerEnv(generic, {}, {})).toEqual({});
  });
});

test("Grok read-only profiles disable the shared leader independently of network flags", () => {
  const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok" });
  for (const trustProject of [false, true]) {
    expect(
      providerArgv(config, {
        approvals: "deny",
        trustProject,
        readOnlyProfilePath: "/private/profile.md",
      }),
    ).toEqual(["agent", "--no-leader", "--agent-profile", "/private/profile.md", "stdio"]);
    expect(
      providerArgv(config, {
        approvals: "deny",
        denyNetwork: true,
        trustProject,
        readOnlyProfilePath: "/private/profile.md",
      }),
    ).toEqual([
      "--disable-web-search",
      "agent",
      "--no-leader",
      "--agent-profile",
      "/private/profile.md",
      "stdio",
    ]);
  }
});

test("refuses a read-only profile when the Grok launcher cannot load it", () => {
  const config = loadAcpProviderConfig({ ACP_PROVIDER: "grok" });
  expect(() =>
    providerArgv({ ...config, argv: ["stdio"] }, { readOnlyProfilePath: "/private/profile.md" }),
  ).toThrow("read-only profile requires a local agent launcher");
});
