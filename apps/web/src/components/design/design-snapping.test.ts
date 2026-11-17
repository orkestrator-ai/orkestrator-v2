import { describe, expect, test } from "bun:test";
import {
  DESIGN_GRID_SIZE,
  alignmentGuides,
  framesInMarquee,
  gridStep,
  rectFromPoints,
  snapMove,
  snapResize,
  snapToGrid,
  unionRect,
} from "./design-snapping";

const neighbour = { x: 500, y: 100, width: 400, height: 300 };

describe("design snapping", () => {
  test("the displayed grid step is a multiple of the snap pitch and never too dense", () => {
    expect(gridStep(1)).toBe(20);
    expect(gridStep(2)).toBe(10);
    expect(gridStep(0.65)).toBe(20);
    expect(gridStep(0.1)).toBe(200);
    expect(gridStep(0.05)).toBe(500);
    for (const zoom of [0.05, 0.13, 0.4, 0.65, 1, 1.7, 4]) {
      const step = gridStep(zoom);
      expect(step % DESIGN_GRID_SIZE).toBe(0);
      expect(step * zoom).toBeGreaterThanOrEqual(12);
    }
    expect(gridStep(Number.NaN)).toBe(20);
  });

  test("a free move away from other frames lands its corner on the grid", () => {
    const result = snapMove({ x: 13, y: 26, width: 300, height: 200 }, [], { threshold: 6 });
    expect(result.rect).toEqual({ x: 10, y: 30, width: 300, height: 200 });
    expect(result.guides).toEqual([]);
    expect(snapToGrid(-14)).toBe(-10);
  });

  test("dragging vertically next to a frame snaps the tops together and draws a guide between them", () => {
    const result = snapMove({ x: 0, y: 104, width: 400, height: 200 }, [neighbour], {
      threshold: 6,
    });
    expect(result.rect.y).toBe(100);
    expect(result.guides).toEqual([{ axis: "y", position: 100, start: 0, end: 900 }]);
  });

  test("bottoms snap together when they are closer than the tops", () => {
    const result = snapMove({ x: 0, y: 197, width: 400, height: 200 }, [neighbour], {
      threshold: 6,
    });
    expect(result.rect.y).toBe(200);
    expect(result.guides).toEqual([{ axis: "y", position: 400, start: 0, end: 900 }]);
  });

  test("a frame of the same height matches top and bottom with two guides", () => {
    const result = snapMove({ x: 0, y: 95, width: 400, height: 300 }, [neighbour], {
      threshold: 6,
    });
    expect(result.rect.y).toBe(100);
    expect(result.guides.filter((guide) => guide.axis === "y")).toEqual([
      { axis: "y", position: 100, start: 0, end: 900 },
      { axis: "y", position: 400, start: 0, end: 900 },
    ]);
  });

  test("alignment beyond the threshold falls back to the grid", () => {
    const result = snapMove({ x: 0, y: 112, width: 400, height: 200 }, [neighbour], {
      threshold: 6,
    });
    expect(result.rect.y).toBe(110);
    expect(result.guides).toEqual([]);
  });

  test("left and right edges align too, with vertical guides", () => {
    const result = snapMove({ x: 503, y: 600, width: 200, height: 100 }, [neighbour], {
      threshold: 6,
    });
    expect(result.rect.x).toBe(500);
    expect(result.guides).toEqual([{ axis: "x", position: 500, start: 100, end: 700 }]);
  });

  test("resizing snaps the dragged edges to neighbours, else to the grid, never below the minimum", () => {
    const toNeighbour = snapResize({ x: 0, y: 100, width: 333, height: 297 }, [neighbour], {
      threshold: 6,
    });
    expect(toNeighbour.rect).toEqual({ x: 0, y: 100, width: 330, height: 300 });
    expect(toNeighbour.guides).toEqual([
      { axis: "y", position: 100, start: 0, end: 900 },
      { axis: "y", position: 400, start: 0, end: 900 },
    ]);
    const tiny = snapResize({ x: 3, y: 3, width: 1, height: 1 }, [], {
      threshold: 6,
      minSize: 32,
    });
    expect(tiny.rect).toMatchObject({ width: 32, height: 32 });
  });

  test("guides are only drawn for exact matches", () => {
    expect(alignmentGuides({ x: 0, y: 101, width: 100, height: 100 }, [neighbour])).toEqual([]);
  });

  test("a marquee selects every frame it touches, dragged in any direction", () => {
    const frames = [
      { id: "a", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", x: 200, y: 0, width: 100, height: 100 },
      { id: "c", x: 0, y: 300, width: 100, height: 100 },
    ];
    const box = rectFromPoints({ x: 250, y: 150 }, { x: 50, y: 50 });
    expect(box).toEqual({ x: 50, y: 50, width: 200, height: 100 });
    expect(framesInMarquee(box, frames)).toEqual(["a", "b"]);
    expect(framesInMarquee({ x: 120, y: 120, width: 50, height: 50 }, frames)).toEqual([]);
  });

  test("union bounds cover every rectangle", () => {
    expect(unionRect([])).toBeNull();
    expect(
      unionRect([
        { x: 0, y: 10, width: 100, height: 100 },
        { x: -50, y: 50, width: 20, height: 200 },
      ]),
    ).toEqual({ x: -50, y: 10, width: 150, height: 240 });
  });
});
