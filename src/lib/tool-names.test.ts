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
    expect(getToolDisplayName("bash")).toBe("Run Command");
    expect(getToolDisplayName("Bash")).toBe("Run Command");
    expect(getToolDisplayName("apply_patch")).toBe("Apply Patch");
    expect(getToolDisplayName("exec_command")).toBe("Exec Command");
    expect(getToolDisplayName("web_search")).toBe("Web Search");
    expect(getToolDisplayName("edit")).toBe("Edit");
    expect(getToolDisplayName("Read")).toBe("Read");
  });

  test("uses the requested fallback when the raw tool name is missing", () => {
    expect(getToolDisplayName()).toBe("Unknown tool");
    expect(getToolDisplayName(undefined, "Task")).toBe("Task");
  });
});
