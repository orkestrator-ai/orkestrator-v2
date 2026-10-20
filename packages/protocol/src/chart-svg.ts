/**
 * Self-contained SVG serialization of a chart scene.
 *
 * Used by the backend to validate and export native charts and by the
 * renderer for "Download SVG". Elements are built as a small tree and
 * serialized with escaping in one place; no caller-supplied string is ever
 * concatenated into markup. The output has a title, description, explicit
 * dimensions and viewBox, resolved inline styles and no external fonts,
 * images or links.
 */
import { formatExactValue, type ChartScene } from "./chart-scene.js";

export type ChartTheme = "light" | "dark";

/** Palette slots with ≥3:1 contrast against each theme's surface. */
export const CHART_PALETTE: Record<ChartTheme, readonly string[]> = {
  light: ["#2563eb", "#d97706", "#059669", "#db2777", "#7c3aed", "#0891b2", "#65a30d", "#dc2626"],
  dark: ["#60a5fa", "#fbbf24", "#34d399", "#f472b6", "#a78bfa", "#22d3ee", "#a3e635", "#f87171"],
};

/** Non-colour distinctions, by the same slot. */
export const CHART_DASH_PATTERNS: readonly string[] = ["", "6 3", "2 3", "8 3 2 3", "1 2", "10 4"];
export const CHART_MARKERS = ["circle", "square", "triangle", "diamond", "cross", "ring"] as const;

const THEME_COLORS: Record<
  ChartTheme,
  { background: string; text: string; muted: string; grid: string }
> = {
  light: { background: "#ffffff", text: "#111827", muted: "#4b5563", grid: "#e5e7eb" },
  dark: { background: "#111827", text: "#f3f4f6", muted: "#9ca3af", grid: "#374151" },
};

export function chartSlotColor(slot: number, theme: ChartTheme): string {
  const palette = CHART_PALETTE[theme];
  return palette[slot % palette.length]!;
}

interface SvgNode {
  tag: string;
  attrs: Record<string, string | number | undefined>;
  children: Array<SvgNode | string>;
}

const ALLOWED_TAGS = new Set([
  "svg",
  "title",
  "desc",
  "g",
  "rect",
  "path",
  "line",
  "text",
  "circle",
  "polygon",
  "pattern",
  "defs",
]);
const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9-]*$/;

function el(
  tag: string,
  attrs: SvgNode["attrs"] = {},
  children: SvgNode["children"] = [],
): SvgNode {
  if (!ALLOWED_TAGS.has(tag)) throw new Error(`Unsupported SVG element ${tag}`);
  return { tag, attrs, children };
}

export function escapeXmlText(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function serialize(node: SvgNode | string): string {
  if (typeof node === "string") return escapeXmlText(node);
  const attrs = Object.entries(node.attrs)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([name, value]) => {
      if (!ATTRIBUTE_NAME.test(name) || name.startsWith("on") || name === "href") {
        throw new Error(`Unsupported SVG attribute ${name}`);
      }
      const text =
        typeof value === "number" ? String(Math.round(value * 100) / 100) : String(value);
      return ` ${name}="${escapeXmlAttribute(text)}"`;
    })
    .join("");
  if (node.children.length === 0) return `<${node.tag}${attrs}/>`;
  return `<${node.tag}${attrs}>${node.children.map(serialize).join("")}</${node.tag}>`;
}

function textEl(x: number, y: number, content: string, attrs: SvgNode["attrs"] = {}): SvgNode {
  return el("text", { x, y, ...attrs }, [
    content.length > 80 ? `${content.slice(0, 79)}…` : content,
  ]);
}

function markerPath(
  marker: (typeof CHART_MARKERS)[number],
  x: number,
  y: number,
  r: number,
): SvgNode {
  switch (marker) {
    case "square":
      return el("rect", { x: x - r, y: y - r, width: r * 2, height: r * 2 });
    case "triangle":
      return el("polygon", { points: `${x},${y - r} ${x + r},${y + r} ${x - r},${y + r}` });
    case "diamond":
      return el("polygon", { points: `${x},${y - r} ${x + r},${y} ${x},${y + r} ${x - r},${y}` });
    case "cross":
      return el("path", {
        d: `M${x - r} ${y - r}L${x + r} ${y + r}M${x - r} ${y + r}L${x + r} ${y - r}`,
        "stroke-width": 2,
      });
    case "ring":
      return el("circle", { cx: x, cy: y, r, fill: "none", "stroke-width": 2 });
    default:
      return el("circle", { cx: x, cy: y, r });
  }
}

/** Render a scene to a standalone SVG document string. */
export function chartSceneToSvg(scene: ChartScene, theme: ChartTheme = "light"): string {
  const colors = THEME_COLORS[theme];
  const children: SvgNode[] = [
    el("title", {}, [scene.title]),
    el("desc", {}, [`${scene.description} ${scene.summary}`.trim()]),
    el("rect", { x: 0, y: 0, width: scene.width, height: scene.height, fill: colors.background }),
  ];
  const fontAttrs = {
    "font-family": "system-ui, -apple-system, Segoe UI, sans-serif",
    "font-size": 11,
    fill: colors.muted,
  };

  if (scene.kind !== "donut") {
    const axes: SvgNode[] = [];
    for (const tick of scene.yAxis.ticks) {
      axes.push(
        el("line", {
          x1: scene.plot.x,
          x2: scene.plot.x + scene.plot.width,
          y1: tick.position,
          y2: tick.position,
          stroke: colors.grid,
        }),
      );
      axes.push(
        textEl(scene.plot.x - 6, tick.position + 4, tick.label, {
          ...fontAttrs,
          "text-anchor": "end",
        }),
      );
    }
    if (scene.kind === "bar") {
      for (const category of scene.categories) {
        axes.push(
          textEl(category.center, scene.plot.y + scene.plot.height + 16, category.label, {
            ...fontAttrs,
            "text-anchor": "middle",
          }),
        );
      }
    } else {
      for (const tick of scene.xAxis.ticks) {
        axes.push(
          el("line", {
            x1: tick.position,
            x2: tick.position,
            y1: scene.plot.y,
            y2: scene.plot.y + scene.plot.height,
            stroke: colors.grid,
          }),
        );
        axes.push(
          textEl(tick.position, scene.plot.y + scene.plot.height + 16, tick.label, {
            ...fontAttrs,
            "text-anchor": "middle",
          }),
        );
      }
    }
    const xLabel = scene.xAxis.unit
      ? `${scene.xAxis.label} (${scene.xAxis.unit})`
      : scene.xAxis.label;
    const yLabel = scene.yAxis.unit
      ? `${scene.yAxis.label} (${scene.yAxis.unit})`
      : scene.yAxis.label;
    axes.push(
      textEl(scene.plot.x + scene.plot.width / 2, scene.height - 8, xLabel, {
        ...fontAttrs,
        "text-anchor": "middle",
        fill: colors.text,
      }),
    );
    axes.push(
      textEl(14, scene.plot.y + scene.plot.height / 2, yLabel, {
        ...fontAttrs,
        "text-anchor": "middle",
        fill: colors.text,
        transform: `rotate(-90 14 ${scene.plot.y + scene.plot.height / 2})`,
      }),
    );
    children.push(el("g", { "data-part": "axes" }, axes));
  }

  const marks: SvgNode[] = [];
  switch (scene.kind) {
    case "bar":
      for (const bar of scene.bars) {
        const color = chartSlotColor(bar.slot, theme);
        if (bar.missing) {
          // Missing is visibly distinct from zero: a dashed outline marker at the baseline.
          marks.push(
            el("rect", {
              x: bar.x + 1,
              y: bar.y - 6,
              width: Math.max(1, bar.width - 2),
              height: 6,
              fill: "none",
              stroke: color,
              "stroke-dasharray": "2 2",
            }),
          );
          continue;
        }
        marks.push(
          el(
            "rect",
            {
              x: bar.x + 1,
              y: bar.y,
              width: Math.max(1, bar.width - 2),
              height: Math.max(0, bar.height),
              fill: color,
              stroke: colors.background,
              "stroke-dasharray": CHART_DASH_PATTERNS[bar.slot % CHART_DASH_PATTERNS.length],
            },
            [el("title", {}, [formatExactValue(bar.value)])],
          ),
        );
      }
      marks.push(
        el("line", {
          x1: scene.plot.x,
          x2: scene.plot.x + scene.plot.width,
          y1: scene.baselineY,
          y2: scene.baselineY,
          stroke: colors.text,
          "stroke-width": 1.5,
        }),
      );
      break;
    case "line":
    case "area":
    case "scatter":
      for (const area of scene.areas) {
        marks.push(
          el("polygon", {
            points: area.points
              .map((p) => `${Math.round(p.px * 100) / 100},${Math.round(p.py * 100) / 100}`)
              .join(" "),
            fill: chartSlotColor(area.slot, theme),
            "fill-opacity": 0.25,
          }),
        );
      }
      for (const segment of scene.segments) {
        const d = segment.points
          .map(
            (p, index) =>
              `${index === 0 ? "M" : "L"}${Math.round(p.px * 100) / 100} ${Math.round(p.py * 100) / 100}`,
          )
          .join("");
        marks.push(
          el("path", {
            d,
            fill: "none",
            stroke: chartSlotColor(segment.slot, theme),
            "stroke-width": 2,
            "stroke-dasharray": CHART_DASH_PATTERNS[segment.slot % CHART_DASH_PATTERNS.length],
          }),
        );
      }
      for (const point of scene.points) {
        const color = chartSlotColor(point.slot, theme);
        const marker = CHART_MARKERS[point.slot % CHART_MARKERS.length]!;
        const node = markerPath(marker, point.px, point.py, scene.kind === "scatter" ? 4 : 2.5);
        node.attrs.fill = node.attrs.fill === "none" ? "none" : color;
        node.attrs.stroke = color;
        node.children.push(el("title", {}, [`${point.x}, ${formatExactValue(point.y)}`]));
        marks.push(node);
      }
      if (scene.baselineY !== null) {
        marks.push(
          el("line", {
            x1: scene.plot.x,
            x2: scene.plot.x + scene.plot.width,
            y1: scene.baselineY,
            y2: scene.baselineY,
            stroke: colors.text,
          }),
        );
      }
      break;
    case "donut":
      if (scene.empty) {
        marks.push(
          el("circle", {
            cx: scene.center.x,
            cy: scene.center.y,
            r: (scene.outerRadius + scene.innerRadius) / 2,
            fill: "none",
            stroke: colors.grid,
            "stroke-width": scene.outerRadius - scene.innerRadius,
          }),
        );
        marks.push(
          textEl(scene.center.x, scene.center.y + 4, "No positive values", {
            ...fontAttrs,
            "text-anchor": "middle",
          }),
        );
        break;
      }
      for (const arc of scene.arcs) {
        if (!arc.path) continue;
        marks.push(
          el(
            "path",
            {
              d: arc.path,
              fill: chartSlotColor(arc.slot, theme),
              stroke: colors.background,
              "stroke-width": 1,
              "fill-rule": "evenodd",
            },
            [el("title", {}, [`${arc.label}: ${arc.value} (${arc.percent.toFixed(1)}%)`])],
          ),
        );
      }
      marks.push(
        textEl(scene.center.x, scene.center.y + 4, `Total ${scene.total}`, {
          ...fontAttrs,
          "text-anchor": "middle",
          fill: colors.text,
          "font-size": 13,
        }),
      );
      break;
  }
  children.push(el("g", { "data-part": "marks" }, marks));

  const legend: SvgNode[] = [];
  scene.legend.forEach((entry, index) => {
    const x = 8 + (index % 4) * 150;
    const y = 12 + Math.floor(index / 4) * 14;
    legend.push(
      el("rect", {
        x,
        y: y - 8,
        width: 10,
        height: 10,
        fill: chartSlotColor(entry.slot, theme),
        "fill-opacity": entry.hidden ? 0.2 : 1,
      }),
    );
    legend.push(
      textEl(x + 14, y + 1, entry.hidden ? `${entry.label} (hidden)` : entry.label, {
        ...fontAttrs,
        fill: colors.text,
      }),
    );
  });
  children.push(el("g", { "data-part": "legend" }, legend));

  return `<?xml version="1.0" encoding="UTF-8"?>\n${serialize(
    el(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: scene.width,
        height: scene.height,
        viewBox: `0 0 ${scene.width} ${scene.height}`,
        role: "img",
      },
      children,
    ),
  )}`;
}
