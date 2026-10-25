/**
 * Smooth SVG paths for the usage chart.
 *
 * The curve is a monotone cubic (Fritsch–Carlson tangents), not a plain
 * Catmull-Rom: an ordinary spline overshoots after a spike, which here would
 * draw a day as having processed more tokens than it did and dip the curve
 * below zero on the way back down. A monotone curve only ever bends between
 * the values it joins.
 */

export interface ChartPoint {
  x: number;
  y: number;
}

function round(value: number): string {
  return value.toFixed(2);
}

/** Fritsch–Carlson tangents: smooth, and never outside the values they join. */
function tangents(points: readonly ChartPoint[]): number[] {
  const count = points.length;
  const widths: number[] = [];
  const slopes: number[] = [];
  for (let index = 0; index < count - 1; index += 1) {
    const width = points[index + 1]!.x - points[index]!.x;
    widths.push(width);
    slopes.push(width === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / width);
  }
  const result = Array.from({ length: count }, () => 0);
  result[0] = slopes[0] ?? 0;
  result[count - 1] = slopes[count - 2] ?? 0;
  for (let index = 1; index < count - 1; index += 1) {
    const before = slopes[index - 1]!;
    const after = slopes[index]!;
    // A turning point gets a flat tangent, which is what keeps the curve
    // inside the data rather than looping past a peak or trough.
    if (before * after <= 0) {
      result[index] = 0;
      continue;
    }
    const weightBefore = 2 * widths[index]! + widths[index - 1]!;
    const weightAfter = widths[index]! + 2 * widths[index - 1]!;
    result[index] = (weightBefore + weightAfter) / (weightBefore / before + weightAfter / after);
  }
  return result;
}

/** The smoothed line through `points`, in source order. */
export function smoothLinePath(points: readonly ChartPoint[]): string {
  if (points.length === 0) return "";
  const start = `M${round(points[0]!.x)},${round(points[0]!.y)}`;
  if (points.length === 1) return start;
  if (points.length === 2) {
    return `${start} L${round(points[1]!.x)},${round(points[1]!.y)}`;
  }
  const slopes = tangents(points);
  let path = start;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const third = (to.x - from.x) / 3;
    path +=
      ` C${round(from.x + third)},${round(from.y + slopes[index]! * third)}` +
      ` ${round(to.x - third)},${round(to.y - slopes[index + 1]! * third)}` +
      ` ${round(to.x)},${round(to.y)}`;
  }
  return path;
}

/** The same line closed down to `baselineY`, for the band under it. */
export function smoothAreaPath(points: readonly ChartPoint[], baselineY: number): string {
  if (points.length === 0) return "";
  const line = smoothLinePath(points);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return `${line} L${round(last.x)},${round(baselineY)} L${round(first.x)},${round(baselineY)} Z`;
}
