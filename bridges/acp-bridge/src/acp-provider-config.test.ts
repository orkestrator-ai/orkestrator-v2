import { describe, expect, test } from "bun:test";
import { loadAcpProviderConfig, providerArgv } from "./acp-provider-config.js";

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
});
