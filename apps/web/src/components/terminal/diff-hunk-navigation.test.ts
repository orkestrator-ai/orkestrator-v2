import { describe, expect, test } from "bun:test";
import {
  hunkLayout,
  isEditableTarget,
  navigate,
  navigationCommandForKey,
} from "./diff-hunk-navigation";

const files = (...counts: number[]) => counts.map((count) => ({ hunks: Array(count).fill(0) }));

describe("hunkLayout and navigate", () => {
  test("orders hunks file by file and skips files without hunks", () => {
    const layout = hunkLayout(files(2, 0, 1));
    expect(layout.positions).toEqual([
      { fileIndex: 0, hunkIndex: 0 },
      { fileIndex: 0, hunkIndex: 1 },
      { fileIndex: 2, hunkIndex: 0 },
    ]);
    expect(layout.fileStarts).toEqual([0, null, 2]);
  });

  test("hunk steps stop at both ends", () => {
    const layout = hunkLayout(files(3));
    expect(navigate(layout, null, "next-hunk")).toBe(0);
    expect(navigate(layout, 0, "next-hunk")).toBe(1);
    expect(navigate(layout, 2, "next-hunk")).toBe(2);
    expect(navigate(layout, 0, "previous-hunk")).toBe(0);
    expect(navigate(hunkLayout([]), null, "next-hunk")).toBeNull();
  });

  test("file steps land on the first hunk of the neighbouring file with hunks", () => {
    const layout = hunkLayout(files(2, 0, 1, 3));
    expect(navigate(layout, 1, "next-file")).toBe(2);
    expect(navigate(layout, 2, "next-file")).toBe(3);
    expect(navigate(layout, 3, "next-file")).toBe(3);
    expect(navigate(layout, 4, "previous-file")).toBe(2);
    expect(navigate(layout, 2, "previous-file")).toBe(0);
    expect(navigate(layout, 1, "previous-file")).toBe(0);
    expect(navigate(layout, null, "previous-file")).toBe(0);
  });
});

describe("navigationCommandForKey", () => {
  const key = (
    k: string,
    mods: Partial<Record<"altKey" | "shiftKey" | "ctrlKey" | "metaKey", boolean>> = {},
  ) => ({
    key: k,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  });

  test("maps brackets and Alt+arrows, and leaves everything else alone", () => {
    expect(navigationCommandForKey(key("]"))).toBe("next-hunk");
    expect(navigationCommandForKey(key("["))).toBe("previous-hunk");
    expect(navigationCommandForKey(key("}", { shiftKey: true }))).toBe("next-file");
    expect(navigationCommandForKey(key("{", { shiftKey: true }))).toBe("previous-file");
    expect(navigationCommandForKey(key("ArrowDown", { altKey: true }))).toBe("next-hunk");
    expect(navigationCommandForKey(key("ArrowUp", { altKey: true, shiftKey: true }))).toBe(
      "previous-file",
    );
    expect(navigationCommandForKey(key("ArrowDown"))).toBeNull();
    expect(navigationCommandForKey(key("]", { metaKey: true }))).toBeNull();
    expect(navigationCommandForKey(key("s"))).toBeNull();
  });

  test("text fields keep their keys", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("input"))).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
