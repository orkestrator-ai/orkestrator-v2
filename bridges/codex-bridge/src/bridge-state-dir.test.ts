import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { codexBridgeStateDir, codexLoginBridgeDir } from "./bridge-state-dir.js";

describe("codexBridgeStateDir", () => {
  test("defaults to the login's own bridge directory", () => {
    expect(codexBridgeStateDir("/home/u/.codex", {})).toBe(
      join("/home/u/.codex", "orkestrator-bridge"),
    );
    expect(codexLoginBridgeDir("/home/u/.codex")).toBe(
      join("/home/u/.codex", "orkestrator-bridge"),
    );
  });

  test("uses the directory the backend names for an added account", () => {
    expect(
      codexBridgeStateDir("/data/agent-accounts/codex/id", {
        CODEX_BRIDGE_STATE_DIR: " /home/u/.codex/orkestrator-bridge ",
      }),
    ).toBe("/home/u/.codex/orkestrator-bridge");
  });

  test("ignores a blank or relative override", () => {
    expect(codexBridgeStateDir("/h", { CODEX_BRIDGE_STATE_DIR: "  " })).toBe(
      join("/h", "orkestrator-bridge"),
    );
    expect(codexBridgeStateDir("/h", { CODEX_BRIDGE_STATE_DIR: "relative/dir" })).toBe(
      join("/h", "orkestrator-bridge"),
    );
  });
});
