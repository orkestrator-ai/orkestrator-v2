import { describe, expect, test } from "bun:test";

import {
  getToolDisplayName,
  getToolTitleDisplayName,
  isEditTool,
  normalizeToolLabelKey,
} from "./tool-names";

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
    expect(getToolDisplayName("todowrite")).toBe("Todo Write");
    expect(getToolDisplayName("TodoWrite")).toBe("Todo Write");
    expect(getToolDisplayName("edit")).toBe("Edit");
    expect(getToolDisplayName("Read")).toBe("Read");
  });

  test("uses the requested fallback when the raw tool name is missing", () => {
    expect(getToolDisplayName()).toBe("Unknown tool");
    expect(getToolDisplayName(undefined, "Task")).toBe("Task");
  });

  test("preserves CamelCase identifiers without splitting them", () => {
    expect(getToolDisplayName("WebFetch")).toBe("WebFetch");
    expect(getToolDisplayName("MultiEdit")).toBe("MultiEdit");
  });

  test("preserves acronym words while title-casing the rest", () => {
    expect(getToolDisplayName("web_API")).toBe("Web API");
    expect(getToolDisplayName("API")).toBe("API");
    expect(getToolDisplayName("mcp__server__do_thing")).toBe("Mcp Server Do Thing");
  });

  test("returns whitespace-only input unchanged", () => {
    expect(getToolDisplayName("   ")).toBe("   ");
  });
});

describe("normalizeToolLabelKey", () => {
  test("lowercases and trims", () => {
    expect(normalizeToolLabelKey("  Bash  ")).toBe("bash");
  });

  test("returns null for empty or missing input", () => {
    expect(normalizeToolLabelKey()).toBeNull();
    expect(normalizeToolLabelKey("")).toBeNull();
    expect(normalizeToolLabelKey("   ")).toBeNull();
  });
});

describe("getToolTitleDisplayName", () => {
  test("returns undefined when no title is provided", () => {
    expect(getToolTitleDisplayName(undefined, "bash")).toBeUndefined();
    expect(getToolTitleDisplayName("", "bash")).toBeUndefined();
  });

  test("humanizes a title that merely duplicates the tool name", () => {
    expect(getToolTitleDisplayName("bash", "bash")).toBe("Run Command");
    expect(getToolTitleDisplayName("Bash", "bash")).toBe("Run Command");
  });

  test("humanizes a title that merely duplicates the content", () => {
    expect(getToolTitleDisplayName("apply_patch", undefined, "apply_patch")).toBe(
      "Apply Patch",
    );
  });

  test("preserves a genuinely descriptive title verbatim", () => {
    expect(getToolTitleDisplayName("Inspect the Codex integration", "Agent")).toBe(
      "Inspect the Codex integration",
    );
    expect(getToolTitleDisplayName("CustomReviewer", "Agent")).toBe(
      "CustomReviewer",
    );
  });

  test("never title-cases a command-like title even if it matches content", () => {
    expect(
      getToolTitleDisplayName("rg -n codex src", "bash", "rg -n codex src"),
    ).toBe("rg -n codex src");
  });
});
