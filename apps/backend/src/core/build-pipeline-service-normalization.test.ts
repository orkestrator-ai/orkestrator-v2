import { describe, expect, test } from "bun:test";
import { normalizeReviewers } from "./build-pipeline-service-helpers.js";

describe("normalizeReviewers", () => {
  test("keeps agent-specific models and drops placeholder effort values", () => {
    expect(
      normalizeReviewers([
        { agent: "claude", model: "  default  ", reasoningEffort: " high " },
        { agent: "codex", model: " default ", reasoningEffort: " default " },
        { agent: "opencode", model: "  provider/model  ", reasoningEffort: " medium " },
      ]),
    ).toEqual([
      { agent: "claude", model: "default", reasoningEffort: "high" },
      { agent: "codex" },
      { agent: "opencode", model: "provider/model", reasoningEffort: "medium" },
    ]);
  });

  test("keeps the classic path for zero or one reviewer", () => {
    expect(normalizeReviewers(undefined)).toBeUndefined();
    expect(normalizeReviewers([])).toBeUndefined();
    expect(normalizeReviewers([{ agent: "claude", model: "opus" }])).toBeUndefined();
  });
});
