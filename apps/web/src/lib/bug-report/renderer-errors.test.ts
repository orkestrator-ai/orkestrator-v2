import { afterEach, describe, expect, test } from "bun:test";
import {
  MAX_BUG_REPORT_RENDERER_ERROR_CHARS,
  MAX_BUG_REPORT_RENDERER_ERRORS,
} from "@orkestrator/protocol/bug-report";
import {
  recentRendererErrors,
  recordRendererError,
  resetRendererErrorsForTests,
} from "./renderer-errors";

afterEach(() => resetRendererErrorsForTests());

describe("renderer error recorder", () => {
  test("keeps a bounded, deduplicated tail", () => {
    for (let index = 0; index < MAX_BUG_REPORT_RENDERER_ERRORS + 5; index += 1) {
      recordRendererError("console", `error ${index}`);
      recordRendererError("console", `error ${index}`);
    }
    const errors = recentRendererErrors();
    expect(errors).toHaveLength(MAX_BUG_REPORT_RENDERER_ERRORS);
    expect(errors.at(-1)?.message).toBe(`error ${MAX_BUG_REPORT_RENDERER_ERRORS + 4}`);
  });

  test("describes errors and truncates long messages", () => {
    recordRendererError("error", new TypeError("bad thing"));
    recordRendererError("console", "x".repeat(5_000));
    const [first, second] = recentRendererErrors();
    expect(first?.message).toContain("bad thing");
    expect(second?.message.length).toBe(MAX_BUG_REPORT_RENDERER_ERROR_CHARS);
  });
});
