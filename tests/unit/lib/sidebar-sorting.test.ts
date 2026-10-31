import { describe, expect, test } from "bun:test";
import type { ClientRect } from "@dnd-kit/core";
import { buildProjectTree, projectFolderDragId, projectSortableIds } from "@/lib/project-folders";
import { projectTreeSortingStrategy } from "@/lib/sidebar-sorting";

function rect(top: number, height: number): ClientRect {
  return { top, left: 0, right: 240, bottom: top + height, width: 240, height };
}

const FOLDER = projectFolderDragId("Angela");

function shiftsFor(
  tree: ReturnType<typeof buildProjectTree<{ id: string; folder?: string }>>,
  items: string[],
  rects: ClientRect[],
  options?: { crossFolderMoves?: boolean },
) {
  const strategy = projectTreeSortingStrategy(tree, items, options);
  return (active: string, over: string) =>
    Object.fromEntries(
      items.map((id, index) => [
        id,
        strategy({
          activeIndex: items.indexOf(active),
          overIndex: items.indexOf(over),
          index,
          rects,
          activeNodeRect: null,
        })?.y,
      ]),
    );
}

/**
 * `a` and `b` at the root around folder Angela (`m1`, `m2`), then `c`. Rows
 * are 30px; the folder's node is its 30px heading plus both members, so its
 * rect contains theirs.
 */
function sidebar(options?: { crossFolderMoves?: boolean }) {
  const tree = buildProjectTree([
    { id: "a" },
    { id: "m1", folder: "Angela" },
    { id: "m2", folder: "Angela" },
    { id: "b" },
    { id: "c" },
  ]);
  const items = projectSortableIds(tree, []);
  expect(items).toEqual(["a", FOLDER, "m1", "m2", "b", "c"]);
  const rects = [
    rect(0, 30),
    rect(30, 90),
    rect(60, 30),
    rect(90, 30),
    rect(120, 30),
    rect(150, 30),
  ];
  /** Each row's own vertical transform while `active` is over `over`. */
  return shiftsFor(tree, items, rects, options);
}

describe("projectTreeSortingStrategy", () => {
  test("a project over a folder heading moves nothing: the folder takes it in", () => {
    // The reported case: under the flat strategy the heading jumped by its
    // members' height and every member moved twice, piling rows together.
    const shifts = sidebar()("b", FOLDER);
    expect(Object.values(shifts).every((y) => y === 0)).toBe(true);
  });

  test("members ride with their folder instead of moving twice", () => {
    // `a` dropped on `c`: everything after it moves up one row. The members
    // are inside the folder's node, so they carry no shift of their own.
    expect(sidebar()("a", "c")).toEqual({
      a: 150,
      [FOLDER]: -30,
      m1: 0,
      m2: 0,
      b: -30,
      c: -30,
    });
  });

  test("a project over a member opens its gap inside the folder", () => {
    // `b` lands before `m2`: `m2` moves down within the folder, the heading stays.
    expect(sidebar()("b", "m2")).toEqual({ a: 0, [FOLDER]: 0, m1: 0, m2: 30, b: -30, c: 0 });
    // `a` lands after `m1`: the heading and `m1` move up, `m2` stays in place,
    // which relative to its shifted folder is one row down.
    expect(sidebar()("a", "m1")).toEqual({ a: 60, [FOLDER]: -30, m1: 0, m2: 30, b: 0, c: 0 });
  });

  test("a member dragged out of its folder is positioned relative to it", () => {
    expect(sidebar()("m2", "a")).toEqual({ a: 30, [FOLDER]: 30, m1: 0, m2: -120, b: 0, c: 0 });
  });

  test("a folder moves as one block past whole entries", () => {
    // Folder dropped on `b`: `b` moves up by the whole folder, members stay put.
    expect(sidebar()(FOLDER, "b")).toEqual({ a: 0, [FOLDER]: 30, m1: 0, m2: 0, b: -90, c: 0 });
    // Folder dropped on `a`: `a` moves below it.
    expect(sidebar()(FOLDER, "a")).toEqual({ a: 90, [FOLDER]: -30, m1: 0, m2: 0, b: 0, c: 0 });
    // A member is not a place for a folder.
    const shifts = sidebar()(FOLDER, "m1");
    expect(Object.values(shifts).every((y) => y === 0)).toBe(true);
  });

  for (const sourceCollapsed of [false, true]) {
    for (const targetCollapsed of [false, true]) {
      test(`a ${sourceCollapsed ? "collapsed" : "expanded"} folder swaps with a ${targetCollapsed ? "collapsed" : "expanded"} folder as whole blocks`, () => {
        const target = projectFolderDragId("Target");
        const tree = buildProjectTree([
          { id: "a" },
          { id: "m1", folder: "Angela" },
          { id: "m2", folder: "Angela" },
          { id: "n1", folder: "Target" },
          { id: "b" },
        ]);
        const collapsed = [
          ...(sourceCollapsed ? ["Angela"] : []),
          ...(targetCollapsed ? ["Target"] : []),
        ];
        const items = projectSortableIds(tree, collapsed);
        expect(items).toEqual([
          "a",
          FOLDER,
          ...(sourceCollapsed ? [] : ["m1", "m2"]),
          target,
          ...(targetCollapsed ? [] : ["n1"]),
          "b",
        ]);
        const sourceHeight = sourceCollapsed ? 30 : 90;
        const targetHeight = targetCollapsed ? 30 : 60;
        const targetTop = 30 + sourceHeight;
        const rects = [
          rect(0, 30),
          rect(30, sourceHeight),
          ...(sourceCollapsed ? [] : [rect(60, 30), rect(90, 30)]),
          rect(targetTop, targetHeight),
          ...(targetCollapsed ? [] : [rect(targetTop + 30, 30)]),
          rect(targetTop + targetHeight, 30),
        ];
        const shifts = shiftsFor(tree, items, rects);
        const members = {
          ...(sourceCollapsed ? {} : { m1: 0, m2: 0 }),
          ...(targetCollapsed ? {} : { n1: 0 }),
        };
        expect(shifts(FOLDER, target)).toEqual({
          a: 0,
          [FOLDER]: targetHeight,
          [target]: -sourceHeight,
          ...members,
          b: 0,
        });
        expect(shifts(target, FOLDER)).toEqual({
          a: 0,
          [FOLDER]: targetHeight,
          [target]: -sourceHeight,
          ...members,
          b: 0,
        });
        // Hidden members must not contribute height when the next root row
        // crosses both folders, and visible members must not shift twice.
        expect(shifts("a", "b")).toEqual({
          a: sourceHeight + targetHeight + 30,
          [FOLDER]: -30,
          [target]: -30,
          ...members,
          b: -30,
        });
      });
    }
  }

  test("without cross-folder moves only siblings shift", () => {
    const shifts = sidebar({ crossFolderMoves: false })("b", "m2");
    expect(Object.values(shifts).every((y) => y === 0)).toBe(true);
    expect(sidebar({ crossFolderMoves: false })("m2", "m1")).toEqual({
      a: 0,
      [FOLDER]: 0,
      m1: 30,
      m2: -30,
      b: 0,
      c: 0,
    });
  });
});
