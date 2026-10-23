import { describe, expect, test } from "bun:test";
import type { BackendId } from "./federation";
import {
  MAX_INHERITED_SETTINGS_BYTES,
  parseControllerSettingsStore,
  parseInheritedGlobalSettings,
} from "./controller-settings";

describe("controller settings snapshots", () => {
  test("rejects malformed objects and arrays", () => {
    for (const value of [null, [], "settings", 1, new Date(), { toJSON: () => [] }]) {
      expect(() => parseInheritedGlobalSettings(value)).toThrow();
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => parseInheritedGlobalSettings(circular)).toThrow("plain JSON");
    expect(parseInheritedGlobalSettings({ reviewInstruction: "ok", githubToken: "drop" })).toEqual({
      reviewInstruction: "ok",
    });
  });

  test("bounds serialized UTF-8 bytes, including the JSON envelope", () => {
    const overhead = new TextEncoder().encode(JSON.stringify({ reviewInstruction: "" })).length;
    const instruction = "é".repeat(Math.floor((MAX_INHERITED_SETTINGS_BYTES - overhead) / 2));
    const remaining =
      MAX_INHERITED_SETTINGS_BYTES - overhead - new TextEncoder().encode(instruction).length;
    const boundary = { reviewInstruction: instruction + "a".repeat(remaining) };
    expect(parseInheritedGlobalSettings(boundary)).toEqual(boundary);
    expect(() =>
      parseInheritedGlobalSettings({ reviewInstruction: boundary.reviewInstruction + "a" }),
    ).toThrow("too large");
  });

  test("filters corrupt persisted entries and retains valid receipt order", () => {
    const valid = {
      controllerId: "bk_command" as BackendId,
      changedAt: "2026-10-22T00:00:00.000Z",
      settings: { terminalScrollback: 5000 },
    };
    expect(
      parseControllerSettingsStore({
        entries: [
          null,
          [],
          {},
          { ...valid, controllerId: "bad id" },
          { ...valid, changedAt: "invalid" },
          { ...valid, settings: [] },
          valid,
        ],
      }),
    ).toEqual({ version: 1, entries: [valid] });
    expect(parseControllerSettingsStore([])).toEqual({ version: 1, entries: [] });
  });
});
