import { describe, expect, test } from "bun:test";
import {
  ACP_LOCAL_SERVER_KINDS,
  ACP_TOOLCHAIN_NAMES,
  acpBridgeProviderArgument,
  acpContainerUnavailableReason,
  acpProviderLaunchEnv,
  acpProviderLaunchRecord,
  isAcpLocalServerKind,
} from "./acp-provider-launch.js";
import { localServerFields } from "./commands-local-server-lifecycle.js";
import { LOCAL_SERVER_KINDS } from "./local-server-runtime.js";
import { commandMatchesRecordedServer } from "./local-server-reaper.js";

describe("the shared ACP launch descriptor", () => {
  test("Antigravity launches agy acp with a worker per session, and nothing of Grok's", () => {
    const record = acpProviderLaunchRecord("antigravity", "/toolchain/bin/agy");
    expect(record).toMatchObject({
      id: "antigravity",
      name: "Antigravity",
      executable: "/toolchain/bin/agy",
      argv: ["acp", "--process-per-session"],
      requiresAuthenticate: false,
      authMethodEnv: "ORKESTRATOR_ANTIGRAVITY_AUTH_METHOD",
      extensionPrefixes: [],
      modelUpdateMethods: [],
      sessionUpdateMethods: [],
    });
    expect(JSON.stringify(record)).not.toMatch(/x\.ai|GROK|--always-approve/);
  });

  test("Grok keeps its own launcher record", () => {
    expect(acpProviderLaunchRecord("grok", "/toolchain/bin/grok")).toMatchObject({
      id: "grok",
      argv: ["--always-approve", "agent", "{{model}}", "{{effort}}", "stdio"],
      requiresAuthenticate: true,
      authMethodEnv: "GROK_AUTH_METHOD_ID",
      extensionPrefixes: ["x.ai/", "_x.ai/"],
    });
  });

  test("the launch environment names the provider, its binary and its own state", () => {
    const env = acpProviderLaunchEnv("antigravity", {
      executable: "/toolchain/bin/agy",
      stateDirectory: "/data/acp-bridge-state/env-1/antigravity",
      appVersion: "2.40.0",
    });
    expect(env).toMatchObject({
      ACP_PROVIDER: "antigravity",
      ACP_AGENT_PATH: "/toolchain/bin/agy",
      ACP_STATE_DIR: "/data/acp-bridge-state/env-1/antigravity",
      ORKESTRATOR_VERSION: "2.40.0",
    });
    expect(JSON.parse(env.ACP_PROVIDER_CONFIG!)).toEqual(
      acpProviderLaunchRecord("antigravity", "/toolchain/bin/agy"),
    );
    expect(acpProviderLaunchEnv("grok", { executable: "grok" }).ACP_STATE_DIR).toBeUndefined();
  });

  test("every ACP kind is a local server kind with its own toolchain entry", () => {
    for (const kind of ACP_LOCAL_SERVER_KINDS) {
      expect(LOCAL_SERVER_KINDS).toContain(kind);
      expect(isAcpLocalServerKind(kind)).toBe(true);
    }
    expect(isAcpLocalServerKind("cursor")).toBe(false);
    expect(ACP_TOOLCHAIN_NAMES).toEqual({ grok: "grok", antigravity: "antigravity" });
  });

  test("only Antigravity is refused in containers, with a reason", () => {
    expect(acpContainerUnavailableReason("antigravity")).toContain("local environment");
    expect(acpContainerUnavailableReason("grok")).toBeUndefined();
  });
});

describe("Antigravity's process record", () => {
  test("every local server kind has fields of its own", () => {
    const ports = new Set<string>();
    const pids = new Set<string>();
    for (const kind of LOCAL_SERVER_KINDS) {
      const { port, pid } = localServerFields(kind);
      ports.add(String(port));
      pids.add(String(pid));
    }
    expect(ports.size).toBe(LOCAL_SERVER_KINDS.length);
    expect(pids.size).toBe(LOCAL_SERVER_KINDS.length);
    expect(localServerFields("antigravity")).toEqual({
      port: "localAntigravityPort",
      pid: "antigravityBridgePid",
    });
  });

  test("a Grok record never claims an Antigravity bridge, and the other way round", () => {
    const bridge = "/usr/bin/bun /app/bridges/acp-bridge/dist/index.js";
    const antigravity = `${bridge} ${acpBridgeProviderArgument("antigravity")}`;
    const grok = `${bridge} ${acpBridgeProviderArgument("grok")}`;
    expect(commandMatchesRecordedServer("antigravityBridgePid", antigravity)).toBe(true);
    expect(commandMatchesRecordedServer("antigravityBridgePid", grok)).toBe(false);
    expect(commandMatchesRecordedServer("antigravityBridgePid", bridge)).toBe(false);
    expect(commandMatchesRecordedServer("grokBridgePid", grok)).toBe(true);
    // A Grok bridge an older backend started carries no provider argument.
    expect(commandMatchesRecordedServer("grokBridgePid", bridge)).toBe(true);
    expect(commandMatchesRecordedServer("grokBridgePid", antigravity)).toBe(false);
  });
});
