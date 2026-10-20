import { expect, test } from "bun:test";
import { smoothAreaPath, smoothLinePath, type ChartPoint } from "./usage-chart-path";

/** Every control point the path names, so overshoot is checkable. */
function pathY(path: string): number[] {
  return [...path.matchAll(/-?\d+\.\d+,(-?\d+\.\d+)/g)].map((match) =>
    Number.parseFloat(match[1]!),
  );
}

test("degenerate inputs stay drawable", () => {
  expect(smoothLinePath([])).toBe("");
  expect(smoothLinePath([{ x: 0, y: 10 }])).toBe("M0.00,10.00");
  expect(
    smoothLinePath([
      { x: 0, y: 10 },
      { x: 5, y: 2 },
    ]),
  ).toBe("M0.00,10.00 L5.00,2.00");
});

test("a smoothed line passes through every point it was given", () => {
  const points: ChartPoint[] = [
    { x: 0, y: 100 },
    { x: 10, y: 40 },
    { x: 20, y: 70 },
    { x: 30, y: 10 },
  ];
  const path = smoothLinePath(points);
  expect(path.startsWith("M0.00,100.00")).toBe(true);
  for (const point of points.slice(1)) {
    expect(path).toContain(`${point.x.toFixed(2)},${point.y.toFixed(2)}`);
  }
  // Three segments for four points.
  expect(path.split(" C")).toHaveLength(4);
});

test("a spike does not overshoot into values the data never had", () => {
  // A plain spline bulges past the peak here and dips below the floor after
  // it, which would draw days as busier (or emptier) than they were.
  const points: ChartPoint[] = [
    { x: 0, y: 180 },
    { x: 10, y: 180 },
    { x: 20, y: 20 },
    { x: 30, y: 180 },
    { x: 40, y: 180 },
  ];
  const values = pathY(smoothLinePath(points));
  expect(Math.min(...values)).toBeGreaterThanOrEqual(20);
  expect(Math.max(...values)).toBeLessThanOrEqual(180);
});

test("a flat run stays flat", () => {
  const values = pathY(
    smoothLinePath([
      { x: 0, y: 50 },
      { x: 10, y: 50 },
      { x: 20, y: 50 },
    ]),
  );
  expect(values.every((value) => value === 50)).toBe(true);
});

test("the area closes down to the baseline and back", () => {
  const path = smoothAreaPath(
    [
      { x: 0, y: 10 },
      { x: 10, y: 40 },
      { x: 20, y: 25 },
    ],
    200,
  );
  expect(path.endsWith("L20.00,200.00 L0.00,200.00 Z")).toBe(true);
  expect(smoothAreaPath([], 200)).toBe("");
});
