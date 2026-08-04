import { describe, expect, test } from "bun:test";
import { parseCodexSteerCommand } from "./codex-steer-command";

describe("parseCodexSteerCommand", () => {
  test("extracts single-line and multiline steering instructions", () => {
    expect(parseCodexSteerCommand("  /STEER   focus on the failing test  ")).toEqual({
      matched: true,
      input: "focus on the failing test",
    });
    expect(parseCodexSteerCommand("/steer\ncheck the API\nthen the UI")).toEqual({
      matched: true,
      input: "check the API\nthen the UI",
    });
  });

  test("distinguishes an empty steer from an ordinary prompt", () => {
    expect(parseCodexSteerCommand("/steer")).toEqual({ matched: true, input: "" });
    expect(parseCodexSteerCommand("/steer   \n  ")).toEqual({ matched: true, input: "" });
    expect(parseCodexSteerCommand("")).toEqual({ matched: false, input: "" });
    expect(parseCodexSteerCommand("   ")).toEqual({ matched: false, input: "" });
    expect(parseCodexSteerCommand("/steering elsewhere")).toEqual({
      matched: false,
      input: "",
    });
    expect(parseCodexSteerCommand("please /steer this")).toEqual({
      matched: false,
      input: "",
    });
  });

  test("accepts whitespace separators but rejects adjacent and non-leading commands", () => {
    expect(parseCodexSteerCommand("/steer\tcheck the API")).toEqual({
      matched: true,
      input: "check the API",
    });
    for (const value of [
      "/steer-now",
      "/steer:go",
      "/steerx",
      "hi\n/steer check the API",
      "\\steer check the API",
    ]) {
      expect(parseCodexSteerCommand(value)).toEqual({ matched: false, input: "" });
    }
  });
});
