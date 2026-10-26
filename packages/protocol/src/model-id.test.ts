import { describe, expect, test } from "bun:test";
import {
  isRootAssistantRecord,
  normalizeBackendModelId,
  reportsSessionDefault,
  sessionDefaultModel,
} from "@orkestrator/protocol/model-id";

test("the model helpers are available through the package export", async () => {
  const exported = await import("@orkestrator/protocol/model-id");
  expect(exported.normalizeBackendModelId).toBe(normalizeBackendModelId);
  expect(exported.isRootAssistantRecord).toBe(isRootAssistantRecord);
});

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
  test("accepts only absent or blank parent ids on the main chain", () => {
    expect(isRootAssistantRecord(undefined)).toBe(true);
    expect(isRootAssistantRecord(null)).toBe(true);
    expect(isRootAssistantRecord("  ")).toBe(true);
    expect(isRootAssistantRecord(null, false)).toBe(true);
    expect(isRootAssistantRecord("tool-1")).toBe(false);
    expect(isRootAssistantRecord(null, true)).toBe(false);
  });

  test("fails closed for malformed parent and sidechain metadata", () => {
    expect(isRootAssistantRecord(42)).toBe(false);
    expect(isRootAssistantRecord({})).toBe(false);
    expect(isRootAssistantRecord([])).toBe(false);
    expect(isRootAssistantRecord(null, "true")).toBe(false);
    expect(isRootAssistantRecord(null, null)).toBe(false);
    expect(isRootAssistantRecord(null, 0)).toBe(false);
  });
});

describe("sessionDefaultModel", () => {
  test("prefers the marked session default over the first entry", () => {
    const models = [{ id: "first" }, { id: "saved", sessionDefault: true }];
    expect(sessionDefaultModel(models)?.id).toBe("saved");
  });

  test("falls back to the first entry, and to nothing for an empty list", () => {
    const unmarked: { id: string; sessionDefault?: boolean }[] = [
      { id: "first" },
      { id: "second" },
    ];
    expect(sessionDefaultModel(unmarked)?.id).toBe("first");
    expect(sessionDefaultModel([])).toBeUndefined();
  });
});

test("only Pi reports its session default, so only Pi treats an unmarked catalogue as unknown", () => {
  expect(reportsSessionDefault("pi")).toBe(true);
  expect(reportsSessionDefault("claude")).toBe(false);
  expect(reportsSessionDefault("codex")).toBe(false);
});
