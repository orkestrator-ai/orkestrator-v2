import { describe, expect, test } from "bun:test";
import {
  COMPACT_SIDEBAR_WIDTH_PX,
  SIDEBAR_WIDTH_TRANSITION_MS,
  rememberedSidebarWidth,
  shouldAnimateSidebarWidth,
  sidebarMotionPins,
  sidebarPanelConstraints,
  sidebarPanelMode,
  sidebarPanelWidth,
} from "./sidebar-width";

describe("the sidebar panel's mode", () => {
  test("hidden wins over compact", () => {
    expect(sidebarPanelMode({ sidebarOpen: false, compact: true })).toBe("hidden");
    expect(sidebarPanelMode({ sidebarOpen: true, compact: true })).toBe("compact");
    expect(sidebarPanelMode({ sidebarOpen: true, compact: false })).toBe("full");
  });

  test("only the full sidebar's width can vary", () => {
    expect(sidebarPanelConstraints("full")).toEqual({ minSize: "280px", maxSize: "400px" });
    expect(sidebarPanelConstraints("compact")).toEqual({
      minSize: `${COMPACT_SIDEBAR_WIDTH_PX}px`,
      maxSize: `${COMPACT_SIDEBAR_WIDTH_PX}px`,
    });
    expect(sidebarPanelConstraints("hidden")).toEqual({ minSize: "0px", maxSize: "0px" });
  });
});

describe("the width a mode settles on", () => {
  test("compact and hidden ignore the remembered width", () => {
    expect(sidebarPanelWidth("compact", 333)).toBe(COMPACT_SIDEBAR_WIDTH_PX);
    expect(sidebarPanelWidth("hidden", 333)).toBe(0);
  });

  test("full returns to the remembered width, within its limits", () => {
    expect(sidebarPanelWidth("full", 333)).toBe(333);
    expect(sidebarPanelWidth("full", 900)).toBe(400);
    expect(sidebarPanelWidth("full", 56)).toBe(280);
  });
});

describe("the remembered width", () => {
  test("is what the user had", () => {
    expect(rememberedSidebarWidth(280, 344)).toBe(344);
  });

  test("ignores a panel already on its way to another width", () => {
    expect(rememberedSidebarWidth(344, COMPACT_SIDEBAR_WIDTH_PX)).toBe(344);
    expect(rememberedSidebarWidth(344, 0)).toBe(344);
    expect(rememberedSidebarWidth(344, null)).toBe(344);
  });
});

describe("whether a width change animates", () => {
  test("it does, briefly", () => {
    expect(shouldAnimateSidebarWidth({ reducedMotion: false, dragging: false })).toBe(true);
    expect(SIDEBAR_WIDTH_TRANSITION_MS).toBeGreaterThanOrEqual(150);
    expect(SIDEBAR_WIDTH_TRANSITION_MS).toBeLessThanOrEqual(200);
  });

  test("not while a handle is dragged, and not under reduced motion", () => {
    expect(shouldAnimateSidebarWidth({ reducedMotion: false, dragging: true })).toBe(false);
    expect(shouldAnimateSidebarWidth({ reducedMotion: true, dragging: false })).toBe(false);
  });
});

describe("the widths content is held at while panels animate", () => {
  test("narrowing the sidebar: the main column takes its final width at once", () => {
    expect(sidebarMotionPins({ sidebarFrom: 320, sidebarTo: 56, mainFrom: 900 })).toEqual({
      sidebar: 320,
      main: 1164,
    });
  });

  test("widening the sidebar: the main column keeps its width until the end", () => {
    expect(sidebarMotionPins({ sidebarFrom: 56, sidebarTo: 320, mainFrom: 1164 })).toEqual({
      sidebar: 320,
      main: 1164,
    });
  });

  test("a resize handle that comes or goes is held in the main column", () => {
    expect(
      sidebarMotionPins({ sidebarFrom: 320, sidebarTo: 0, mainFrom: 900, separator: 1 }),
    ).toEqual({ sidebar: 320, main: 1221 });
    expect(
      sidebarMotionPins({
        sidebarFrom: 1.25,
        sidebarTo: 0,
        mainFrom: 1000,
        separator: 1.25,
        zoom: 1.25,
      }),
    ).toEqual({ sidebar: 1, main: 802 });
  });
});

for (const zoom of [0.8, 1.25, 1.5]) {
  test(`motion pins convert viewport measurements at zoom ${zoom}`, () => {
    expect(
      sidebarMotionPins({ sidebarFrom: 320 * zoom, sidebarTo: 56, mainFrom: 900 * zoom, zoom }),
    ).toEqual({ sidebar: 320, main: 1164 });
    expect(
      sidebarMotionPins({ sidebarFrom: 56 * zoom, sidebarTo: 320, mainFrom: 1164 * zoom, zoom }),
    ).toEqual({ sidebar: 320, main: 1164 });
  });
}
