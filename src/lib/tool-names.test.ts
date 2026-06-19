import { describe, expect, test } from "bun:test";

import { getToolDisplayName, isEditTool } from "./tool-names";

describe("tool name helpers", () => {
  test("detects edit tools case-insensitively", () => {
    expect(isEditTool("edit")).toBe(true);
    expect(isEditTool("Write")).toBe(true);
    expect(isEditTool("STR_REPLACE_EDITOR")).toBe(true);
    expect(isEditTool("bash")).toBe(false);
    expect(isEditTool()).toBe(false);
  });

  test("maps display-only tool names case-insensitively", () => {
    expect(getToolDisplayName("bash")).toBe("run_command");
    expect(getToolDisplayName("Bash")).toBe("run_command");
    expect(getToolDisplayName("Read")).toBe("Read");
  });

  test("uses the requested fallback when the raw tool name is missing", () => {
    expect(getToolDisplayName()).toBe("Unknown tool");
    expect(getToolDisplayName(undefined, "Task")).toBe("Task");
  });
});
