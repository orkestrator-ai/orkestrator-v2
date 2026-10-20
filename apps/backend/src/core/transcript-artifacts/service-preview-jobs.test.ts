import { describe, expect, test } from "bun:test";
import { staticSanitizerDiagnostics } from "./service-preview-jobs.js";

describe("static sanitizer diagnostics", () => {
  test("reports every removal class so authors learn scripts never run", () => {
    const diagnostics = staticSanitizerDiagnostics({
      scripts: 1,
      handlers: 2,
      externalReferences: 0,
      forbiddenElements: 1,
      executableUrls: 0,
    });
    expect(diagnostics.map((d) => [d.code, d.severity])).toEqual([
      ["static_script_removed", "warning"],
      ["static_handler_removed", "warning"],
      ["static_element_removed", "warning"],
    ]);
    expect(diagnostics[0]!.message).toContain("use html-interactive");
  });

  test("a clean document reports nothing", () => {
    expect(
      staticSanitizerDiagnostics({
        scripts: 0,
        handlers: 0,
        externalReferences: 0,
        forbiddenElements: 0,
        executableUrls: 0,
      }),
    ).toEqual([]);
  });
});
