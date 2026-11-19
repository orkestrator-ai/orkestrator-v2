import { describe, expect, test } from "bun:test";
import {
  MAX_ENVIRONMENT_ORDER_ENTRIES,
  MAX_PORTAL_LAYOUT_ENTRIES,
  parsePortalLayout,
  parsePortalLayoutUpdate,
} from "./portal-layout.js";

describe("portal layout", () => {
  test("a stored layout is read leniently: bad entries are dropped, duplicates collapse", () => {
    expect(
      parsePortalLayout({
        revision: 3,
        machineOrder: ["a", "", 7, "a", "b"],
        projectOrder: "nope",
        projectFolders: { p: "Work", q: 4, r: null },
      }),
    ).toEqual({
      revision: 3,
      machineOrder: ["a", "b"],
      projectOrder: [],
      projectFolders: { p: "Work", r: null },
      repositoryOrder: [],
      environmentOrder: {},
    });
    expect(parsePortalLayout(null).revision).toBe(0);
  });

  test("an update is strict and bounded", () => {
    expect(parsePortalLayoutUpdate({ machineOrder: ["a", "a", "b"] })).toEqual({
      machineOrder: ["a", "b"],
    });
    expect(() => parsePortalLayoutUpdate({ revision: 4 })).toThrow("Unexpected layout field");
    expect(() => parsePortalLayoutUpdate({ projectOrder: [""] })).toThrow();
    expect(() => parsePortalLayoutUpdate({ projectFolders: { p: 3 } })).toThrow();
    expect(() =>
      parsePortalLayoutUpdate({
        repositoryOrder: Array.from({ length: MAX_PORTAL_LAYOUT_ENTRIES + 1 }, (_, i) => `p${i}`),
      }),
    ).toThrow("at most");
  });

  test("the manual environment order is read leniently and bounded in all", () => {
    expect(
      parsePortalLayout({
        environmentOrder: { repo: ["a", "", "a", "b"], "": ["c"], empty: [], bad: "x" },
      }).environmentOrder,
    ).toEqual({ repo: ["a", "b"] });
    const big = Array.from({ length: 4096 }, (_, i) => `e${i}`);
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`r${i}`, big]));
    const read = parsePortalLayout({ environmentOrder: many }).environmentOrder;
    expect(Object.values(read).flat()).toHaveLength(MAX_ENVIRONMENT_ORDER_ENTRIES);
  });

  test("a manual environment order update is strict", () => {
    expect(parsePortalLayoutUpdate({ environmentOrder: { repo: ["a", "a"], none: [] } })).toEqual({
      environmentOrder: { repo: ["a"] },
    });
    expect(() => parsePortalLayoutUpdate({ environmentOrder: ["a"] })).toThrow();
    expect(() => parsePortalLayoutUpdate({ environmentOrder: { repo: [""] } })).toThrow();
    const big = Array.from({ length: 4096 }, (_, i) => `e${i}`);
    expect(() =>
      parsePortalLayoutUpdate({
        environmentOrder: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`r${i}`, big])),
      }),
    ).toThrow("in all");
  });
});
