import { describe, expect, test } from "bun:test";
import {
  detectContainerSetupReadiness,
  ENVIRONMENT_ALREADY_READY_MARKER,
  ENVIRONMENT_READY_MARKER_ALT_DASH,
  ENVIRONMENT_READY_MARKER_ALT_TILDE,
  ENVIRONMENT_SETUP_FAILED_MARKER,
  SETUP_DONE_OSC_DATA,
  SETUP_DONE_OSC_ID,
  SETUP_DONE_PRINTF_CMD,
  SETUP_FAILED_OSC_DATA,
  SETUP_FAILED_PRINTF_CMD,
  SETUP_COMPLETE_MARKER,
  stripAnsi,
  tabTypeToSessionType,
} from "./terminal-utils";

describe("terminal-utils", () => {
  test("maps codex tabs to codex session type", () => {
    expect(tabTypeToSessionType("codex")).toBe("codex");
  });

  test("falls back to plain for non-terminal agent tabs", () => {
    expect(tabTypeToSessionType("plain")).toBe("plain");
    expect(tabTypeToSessionType("claude-native")).toBe("plain");
  });

  test("strips ANSI control sequences", () => {
    expect(stripAnsi("\u001b[31merror\u001b[0m")).toBe("error");
  });

  test("strips OSC control sequences", () => {
    expect(stripAnsi("before\u001b]9999;setup_done\u0007after")).toBe("beforeafter");
  });

  test("exports the setup-complete OSC printf command", () => {
    expect(SETUP_DONE_PRINTF_CMD).toContain(String(SETUP_DONE_OSC_ID));
    expect(SETUP_DONE_PRINTF_CMD).toContain(SETUP_DONE_OSC_DATA);
    expect(SETUP_DONE_PRINTF_CMD.startsWith("printf")).toBe(true);
  });

  test("exports a setup-failed OSC printf command with distinct payload", () => {
    expect(SETUP_FAILED_OSC_DATA).not.toBe(SETUP_DONE_OSC_DATA);
    expect(SETUP_FAILED_PRINTF_CMD).toContain(String(SETUP_DONE_OSC_ID));
    expect(SETUP_FAILED_PRINTF_CMD).toContain(SETUP_FAILED_OSC_DATA);
    expect(SETUP_FAILED_PRINTF_CMD.startsWith("printf")).toBe(true);
  });

  test("exports explicit reused and failed workspace markers", () => {
    expect(ENVIRONMENT_ALREADY_READY_MARKER).toBe("Workspace already set up.");
    expect(ENVIRONMENT_SETUP_FAILED_MARKER).toBe("=== Workspace Setup Failed ===");
  });

  test("detects container setup readiness from restored terminal output", () => {
    expect(detectContainerSetupReadiness("\u001b[32m=== Workspace Ready ===\u001b[0m")).toEqual({
      ready: true,
      failed: false,
    });
    expect(detectContainerSetupReadiness(ENVIRONMENT_READY_MARKER_ALT_TILDE)).toEqual({
      ready: true,
      failed: false,
    });
    expect(detectContainerSetupReadiness(ENVIRONMENT_READY_MARKER_ALT_DASH)).toEqual({
      ready: true,
      failed: false,
    });
    expect(detectContainerSetupReadiness(ENVIRONMENT_ALREADY_READY_MARKER)).toEqual({
      ready: true,
      failed: false,
    });
    expect(detectContainerSetupReadiness(SETUP_COMPLETE_MARKER)).toEqual({
      ready: true,
      failed: false,
    });
    expect(
      detectContainerSetupReadiness("=== Workspace Setup Failed ===\n=== Workspace Ready ===")
    ).toEqual({
      ready: true,
      failed: true,
    });
    expect(detectContainerSetupReadiness("installing packages\n")).toEqual({
      ready: false,
      failed: false,
    });
  });
});
