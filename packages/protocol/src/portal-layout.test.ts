import { describe, expect, test } from "bun:test";
import {
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
});
