import { describe, expect, test } from "bun:test";
import {
  applyToolchainProgress,
  toolchainProgressFraction,
} from "../../../apps/desktop/electron/toolchain-bootstrap-progress";
import type { ToolchainProgress } from "../../../apps/desktop/electron/toolchain-manager";

function progress(overrides: Partial<ToolchainProgress> = {}): ToolchainProgress {
  return {
    phase: "downloading",
    completedTools: 0,
    totalTools: 3,
    message: "Downloading Codex",
    ...overrides,
  };
}

describe("toolchain bootstrap progress rendering", () => {
  test("uses aggregate progress without regressing between download and verification", () => {
    const downloading = progress({ bytesReceived: 100, bytesTotal: 100, overallFraction: 0.6 });
    const verifying = progress({ phase: "verifying", overallFraction: 0.6 });
    const anotherDownload = progress({ tool: "claude", bytesReceived: 1, bytesTotal: 100, overallFraction: 0.603 });

    expect([
      toolchainProgressFraction(downloading),
      toolchainProgressFraction(verifying),
      toolchainProgressFraction(anotherDownload),
    ]).toEqual([0.6, 0.6, 0.603]);
  });

  test("clamps aggregate and legacy progress to the visible range", () => {
    expect(toolchainProgressFraction(progress({ overallFraction: 2 }))).toBe(1);
    expect(toolchainProgressFraction(progress({ overallFraction: -1 }))).toBe(0);
    expect(toolchainProgressFraction(progress({ completedTools: 1, bytesReceived: 50, bytesTotal: 100 }))).toBe(0.5);
    expect(toolchainProgressFraction(progress({ totalTools: 0 }))).toBe(0);
  });

  test("updates text, percentage, and byte detail and reports missing markup", () => {
    const elements = new Map([
      ["message", { textContent: "", style: { width: "" } }],
      ["detail", { textContent: "", style: { width: "" } }],
      ["progress", { textContent: "", style: { width: "" } }],
    ]);
    const document = { getElementById: (id: string) => elements.get(id) ?? null };

    expect(applyToolchainProgress(progress({
      bytesReceived: 1_048_576,
      bytesTotal: 2_097_152,
      overallFraction: 0.25,
    }), document)).toBe(true);
    expect(elements.get("message")?.textContent).toBe("Downloading Codex");
    expect(elements.get("progress")?.style.width).toBe("25%");
    expect(elements.get("detail")?.textContent).toBe("1 of 2 MB");

    elements.delete("detail");
    expect(applyToolchainProgress(progress(), document)).toBe(false);
  });
});
