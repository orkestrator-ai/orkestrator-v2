import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalProvider } from "@/contexts";
import { EditToolPart } from "./NativeMessage.basic-parts";

afterEach(cleanup);

function numbered(count: number, prefix = "line"): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")}\n`;
}

function renderEdit(
  before: string,
  after: string,
  extra: { additions?: number; deletions?: number } = {},
) {
  return render(
    <TerminalProvider>
      <EditToolPart
        expansionKey={`edit-${before.length}-${after.length}`}
        toolName="Edit"
        toolState="success"
        toolDiff={{ filePath: "/workspace/src/big.ts", before, after, ...extra }}
      />
    </TerminalProvider>,
  );
}

describe("EditToolPart before/after diff", () => {
  test("a one-line edit in a long file yields one minimal hunk", () => {
    const before = numbered(2_000);
    const after = before.replace("line 1000\n", "line one thousand\n");
    const { container } = renderEdit(before, after);
    expect(screen.getByText("+1")).toBeTruthy();
    expect(screen.getByText("-1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /edit big\.ts \+1 -1 success/i }));
    const rows = Array.from(container.querySelectorAll("pre > div")).map((row) => row.textContent);
    expect(rows).toEqual([
      "@@ -997,7 +997,7 @@",
      " line 997",
      " line 998",
      " line 999",
      "-line 1000",
      "+line one thousand",
      " line 1001",
      " line 1002",
      " line 1003",
    ]);
  });

  test("a change beyond the inline budget shows a labelled summary, not a fake patch", () => {
    const before = numbered(3_000, "old");
    const after = numbered(3_000, "new");
    const { container } = renderEdit(before, after, { additions: 3_000, deletions: 3_000 });
    fireEvent.click(screen.getByRole("button", { name: /edit big\.ts/i }));
    expect(screen.getByText("Change too large to show inline")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("3000 → 3000 lines");
    expect(container.querySelectorAll("pre > div")).toHaveLength(0);
  });
});
