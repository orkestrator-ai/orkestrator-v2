import { describe, expect, test } from "bun:test";
import {
  MAX_ENVIRONMENT_ORDER_ENTRIES,
  MAX_PORTAL_LAYOUT_ENTRIES,
  applyRepositoryEnvironmentOrder,
  parsePortalLayout,
  parsePortalLayoutUpdate,
  parseRepositoryEnvironmentOrderUpdate,
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

  test("a repository order update is strict and accepts clearing one repository", () => {
    expect(
      parseRepositoryEnvironmentOrderUpdate({ repositoryKey: "repo", order: ["a", "a"] }),
    ).toEqual({ repositoryKey: "repo", order: ["a"] });
    expect(() =>
      parseRepositoryEnvironmentOrderUpdate({ repositoryKey: "", order: ["a"] }),
    ).toThrow();
    expect(() =>
      parseRepositoryEnvironmentOrderUpdate({ repositoryKey: "repo", order: [""] }),
    ).toThrow();
    expect(
      applyRepositoryEnvironmentOrder(
        { repo: ["a"], other: ["b"] },
        {
          repositoryKey: "repo",
          order: [],
        },
      ),
    ).toEqual({ other: ["b"] });
  });

  test("at capacity an order can move its own rows but cannot evict another repository", () => {
    const big = Array.from({ length: MAX_PORTAL_LAYOUT_ENTRIES }, (_, i) => `e${i}`);
    const full = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`r${i}`, big]));
    expect(() =>
      applyRepositoryEnvironmentOrder(full, { repositoryKey: "new", order: ["x", "y"] }),
    ).toThrow("saved Manual order is full");
    const replacement = [...big].reverse();
    expect(
      applyRepositoryEnvironmentOrder(full, { repositoryKey: "r0", order: replacement }),
    ).toEqual({ ...full, r0: replacement });
    expect(full.r0).toEqual(big);
  });
});
