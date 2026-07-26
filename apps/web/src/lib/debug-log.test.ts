import { describe, expect, test } from "bun:test";
import { readDebugPreference } from "./debug-log";

describe("readDebugPreference", () => {
  test("is off when nothing is stored", () => {
    expect(readDebugPreference(null)).toBe(false);
    expect(readDebugPreference(undefined)).toBe(false);
    expect(readDebugPreference("")).toBe(false);
    expect(readDebugPreference("   ")).toBe(false);
  });

  test("is off for the conventional negative spellings, in any case or padding", () => {
    for (const value of ["0", "false", "off", "no", "FALSE", " Off ", "No"]) {
      expect(readDebugPreference(value)).toBe(false);
    }
  });

  test("is on for anything else", () => {
    for (const value of ["1", "true", "yes", "on", "verbose", " 1 "]) {
      expect(readDebugPreference(value)).toBe(true);
    }
  });
});
