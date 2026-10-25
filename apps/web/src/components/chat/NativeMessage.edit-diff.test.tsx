import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ChangeDiffFileBody } from "@orkestrator/protocol/change-resources";
import { TerminalProvider } from "@/contexts";
import type { LegacyPayloadSummary } from "@/lib/backend/changes";
import { invoke } from "@/lib/native/backend";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { EditToolPart } from "./NativeMessage.basic-parts";
import { resetChangePartCachesForTests } from "./NativeMessage.change-parts";

/*
 * A legacy edit row (no backend presentation) shows what the backend measured
 * from its recorded payload. Size limits, truncation and body availability are
 * the backend's decisions; the card renders them and never diffs locally.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
let summary: LegacyPayloadSummary | null = null;

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(async (command: string) =>
    command === "changes_measure_legacy_payload" ? summary : undefined,
  );
});

afterEach(() => {
  cleanup();
  invokeMock.mockImplementation(() => Promise.resolve());
  resetChangePartCachesForTests();
  useMessagePartExpansionStore.getState().reset();
});

function numbered(count: number, prefix = "line"): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")}\n`;
}

function file(overrides: Partial<ChangeDiffFileBody>): ChangeDiffFileBody {
  return {
    pathId: "legacy:big",
    oldPathDisplay: "/workspace/src/big.ts",
    newPathDisplay: "/workspace/src/big.ts",
    status: "modified",
    fileKind: "text",
    bodyAvailability: "available",
    reasonKey: null,
    hunks: [],
    truncated: false,
    ...overrides,
  };
}

function renderEdit(before: string, after: string) {
  return render(
    <TerminalProvider>
      <EditToolPart
        expansionKey={`edit-${before.length}-${after.length}`}
        toolName="Edit"
        toolState="success"
        toolDiff={{ filePath: "/workspace/src/big.ts", before, after }}
      />
    </TerminalProvider>,
  );
}

describe("EditToolPart legacy payload bodies", () => {
  test("sends the full sides to the backend and renders its hunks", async () => {
    const before = numbered(2_000);
    const after = before.replace("line 1000\n", "line one thousand\n");
    summary = {
      provenanceLabelKey: "changes.provenance.legacy-payload",
      additions: { value: 1, quality: "complete", bound: "exact" },
      deletions: { value: 1, quality: "complete", bound: "exact" },
      changedFiles: 1,
      contentLines: null,
      reasonKeys: [],
      files: [
        file({
          hunks: [
            {
              header: "@@ -999,3 +999,3 @@",
              oldStart: 999,
              oldLines: 3,
              newStart: 999,
              newLines: 3,
              lines: [
                { type: "context", text: "line 999", oldLine: 999, newLine: 999 },
                { type: "remove", text: "line 1000", oldLine: 1000, newLine: null },
                { type: "add", text: "line one thousand", oldLine: null, newLine: 1000 },
                { type: "context", text: "line 1001", oldLine: 1001, newLine: 1001 },
              ],
            },
          ],
        }),
      ],
    };
    const { container } = renderEdit(before, after);
    await waitFor(() => expect(screen.getByTestId("legacy-change-badge").textContent).toBe("+1-1"));
    expect(invokeMock).toHaveBeenCalledWith("changes_measure_legacy_payload", {
      toolName: "Edit",
      filePath: "/workspace/src/big.ts",
      before,
      after,
    });

    fireEvent.click(screen.getByRole("button", { name: /edit big\.ts/i }));
    const rows = Array.from(container.querySelectorAll("[data-testid=change-hunks] pre > div")).map(
      (row) => row.textContent,
    );
    expect(rows).toEqual([
      "@@ -999,3 +999,3 @@",
      " line 999",
      "-line 1000",
      "+line one thousand",
      " line 1001",
    ]);
  });

  test("shows the backend's truncation and unavailable-body notes, not a client budget", async () => {
    summary = {
      provenanceLabelKey: "changes.provenance.legacy-payload",
      additions: { value: 3_000, quality: "complete", bound: "exact" },
      deletions: { value: 3_000, quality: "complete", bound: "exact" },
      changedFiles: 1,
      contentLines: null,
      reasonKeys: ["changes.reason.count-omitted"],
      files: [
        file({ truncated: true }),
        file({
          pathId: "legacy:other",
          bodyAvailability: "unavailable",
          reasonKey: "changes.reason.count-omitted",
        }),
      ],
    };
    renderEdit(numbered(3_000, "old"), numbered(3_000, "new"));
    const badge = await screen.findByTestId("legacy-change-badge");
    expect(badge.textContent).toContain("3");
    expect(badge.getAttribute("title")).toContain(
      "Some files were too large or unreadable to count",
    );

    fireEvent.click(screen.getByRole("button", { name: /edit big\.ts/i }));
    expect(screen.queryByText("Change too large to show inline") === null).toBe(true);
    expect(
      screen.getByText("The rendered body stops here; the counts above cover the whole change."),
    ).toBeTruthy();
    expect(
      screen.getAllByText("Some files were too large or unreadable to count").length,
    ).toBeGreaterThan(0);
  });
});
