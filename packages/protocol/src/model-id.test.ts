import { describe, expect, test } from "bun:test";
import { isRootAssistantRecord, normalizeBackendModelId } from "./model-id";

describe("normalizeBackendModelId", () => {
  test("trims real model ids", () => {
    expect(normalizeBackendModelId("  claude-opus-5  ")).toBe("claude-opus-5");
  });

  test("rejects blanks, non-strings, and angle-bracket sentinels", () => {
    expect(normalizeBackendModelId("  ")).toBeUndefined();
    expect(normalizeBackendModelId("<synthetic>")).toBeUndefined();
    expect(normalizeBackendModelId(" <generated> ")).toBeUndefined();
    expect(normalizeBackendModelId(42)).toBeUndefined();
  });
});

describe("isRootAssistantRecord", () => {
  test("accepts root records and rejects subagent or sidechain records", () => {
    expect(isRootAssistantRecord(null)).toBe(true);
    expect(isRootAssistantRecord("  ")).toBe(true);
    expect(isRootAssistantRecord("tool-1")).toBe(false);
    expect(isRootAssistantRecord(null, true)).toBe(false);
  });
});
