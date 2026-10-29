import { describe, expect, test } from "bun:test";
import {
  WORKSPACE_GIT_BASELINE_MAX_PATHS,
  WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS,
  isWorkspaceGitBaseline,
} from "./workspace-guard.js";

const baseline = {
  head: "a".repeat(40),
  paths: ["src/app.ts"],
  capturedAt: "2026-10-29T00:00:00.000Z",
};

describe("isWorkspaceGitBaseline", () => {
  test("accepts a clean or dirty baseline with a full SHA", () => {
    expect(isWorkspaceGitBaseline(baseline)).toBe(true);
    expect(isWorkspaceGitBaseline({ ...baseline, paths: [] })).toBe(true);
    expect(isWorkspaceGitBaseline({ ...baseline, head: "b".repeat(64) })).toBe(true);
  });

  test("rejects malformed, unbounded or extra fields", () => {
    for (const invalid of [
      null,
      [],
      { ...baseline, head: "main" },
      { ...baseline, paths: [""] },
      { ...baseline, paths: ["x".repeat(WORKSPACE_GIT_BASELINE_MAX_PATH_CHARS + 1)] },
      {
        ...baseline,
        paths: Array.from({ length: WORKSPACE_GIT_BASELINE_MAX_PATHS + 1 }, (_, i) => `f${i}`),
      },
      { ...baseline, capturedAt: 0 },
      { ...baseline, capturedAt: "not a date" },
      { ...baseline, status: "clean" },
    ]) {
      expect(isWorkspaceGitBaseline(invalid)).toBe(false);
    }
  });
});
