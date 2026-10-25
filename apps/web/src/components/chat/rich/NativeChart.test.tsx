import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { REPRESENTATIVE_BAR_CHART } from "@orkestrator/protocol/testing/rich-content-fixtures";
import { buildChartScene, chartDataTable, chartToCsv } from "@orkestrator/protocol/chart-scene";
import { chartSceneToSvg } from "@orkestrator/protocol/chart-svg";
import { CHART_POLICY, FRONTEND_RENDER_POLICY } from "@orkestrator/protocol/rich-content-policy";
import type { ChartSpecV1 } from "@orkestrator/protocol/chart-spec";
import { useRichContentViewStore } from "@/stores/richContentViewStore";
import { mockWriteText } from "../../../../../../tests/mocks/clipboard";
import { mockToastError } from "../../../../../../tests/mocks/sonner";
import { sanitizeSvg } from "@/lib/chat/svg-sanitize";
import { NativeChart } from "./NativeChart";
import { ChartFenceBlock } from "./ChartFenceBlock";
import { pinRichViewWithRecovery, resetRichViewPinRecovery } from "./CodeBlockViewer";

function svgSanitizerUsableHere(): boolean {
  try {
    sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    return true;
  } catch {
    return false;
  }
}

const VIEW_KEY = '["block","backend","env","session","m1","p1","chart-0"]';

function renderChart(spec: ChartSpecV1, source?: string) {
  return render(
    <NativeChart spec={spec} viewKey={VIEW_KEY} source={source} provenance={{ kind: "inline" }} />,
  );
}

function marks(container: HTMLElement, kind: string): Element[] {
  return Array.from(container.querySelectorAll(`[data-chart-mark="${kind}"]`));
}

function bar(container: HTMLElement, series: string, category: string): Element {
  const element = container.querySelector(
    `[data-chart-mark="bar"][data-series="${series}"][data-category="${category}"]`,
  );
  if (!element) throw new Error(`missing bar ${series}/${category}`);
  return element;
}

const downloads: Array<{ filename: string; blob: Blob }> = [];
let createObjectUrl: ReturnType<typeof spyOn> | null = null;
let clickSpy: ReturnType<typeof spyOn> | null = null;

beforeEach(() => {
  useRichContentViewStore.getState().reset();
  resetRichViewPinRecovery();
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {});
  downloads.length = 0;
  let pending: Blob | null = null;
  if (typeof URL.createObjectURL !== "function") {
    (URL as unknown as { createObjectURL: (blob: Blob) => string }).createObjectURL = () =>
      "blob:x";
    (URL as unknown as { revokeObjectURL: (url: string) => void }).revokeObjectURL = () => {};
  }
  createObjectUrl = spyOn(URL, "createObjectURL").mockImplementation(((blob: Blob) => {
    pending = blob;
    return "blob:test";
  }) as typeof URL.createObjectURL);
  clickSpy = spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    if (pending) downloads.push({ filename: this.download, blob: pending });
    pending = null;
  });
});

afterEach(() => {
  cleanup();
  createObjectUrl?.mockRestore();
  clickSpy?.mockRestore();
});

describe("NativeChart — representative bar fixture", () => {
  const source = `${JSON.stringify(REPRESENTATIVE_BAR_CHART, null, 2)}\n`;

  test("draws six category/series positions with one visibly missing value and a zero baseline", () => {
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART, source);
    const bars = marks(container, "bar");
    expect(bars).toHaveLength(6);
    const missing = bars.filter((element) => element.getAttribute("data-missing") === "true");
    expect(missing).toHaveLength(1);
    expect(missing[0]!.getAttribute("data-series")).toBe("b");
    expect(missing[0]!.getAttribute("data-category")).toBe("browser");
    expect(missing[0]!.getAttribute("stroke-dasharray")).toBe("2 2");
    expect(container.querySelector('[data-chart-baseline="true"]')).not.toBeNull();
  });

  test("shows two legend labels, three category labels and the synthetic-data note", () => {
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART, source);
    const legend = screen.getByRole("group", { name: /Legend/ });
    expect(
      within(legend)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Run A", "Run B"]);
    const axisText = Array.from(container.querySelectorAll('[data-part="axes"] text')).map(
      (element) => element.querySelector("title")?.textContent,
    );
    for (const label of ["Unit", "Integration", "Browser"]) expect(axisText).toContain(label);
    expect(screen.getByText("All numbers are synthetic test data.")).toBeTruthy();
    expect(screen.getByText("Inline chart from message text")).toBeTruthy();
  });

  test("44 is taller than 40 and a null is not a zero-height success", () => {
    const zeroSpec: ChartSpecV1 = {
      ...REPRESENTATIVE_BAR_CHART,
      series: [
        REPRESENTATIVE_BAR_CHART.series[0]!,
        {
          ...REPRESENTATIVE_BAR_CHART.series[1]!,
          points: [
            { categoryId: "unit", value: 44 },
            { categoryId: "integration", value: 0 },
            { categoryId: "browser", value: null },
          ],
        },
      ],
    };
    const { container } = renderChart(zeroSpec);
    const heightOf = (element: Element) => Number(element.getAttribute("height"));
    expect(heightOf(bar(container, "b", "unit"))).toBeGreaterThan(
      heightOf(bar(container, "a", "unit")),
    );
    const zero = bar(container, "b", "integration");
    const missing = bar(container, "b", "browser");
    expect(zero.getAttribute("data-missing")).toBe("false");
    expect(zero.getAttribute("data-value")).toBe("0");
    expect(heightOf(zero)).toBe(0);
    expect(missing.getAttribute("data-missing")).toBe("true");
    expect(missing.getAttribute("data-value")).toBeNull();
    expect(missing.getAttribute("fill")).toBe("none");
  });

  test("data view keeps source order and exact values, with an explicit missing convention", () => {
    renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Data view" }));
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    const expected = chartDataTable(REPRESENTATIVE_BAR_CHART).rows;
    expect(rows).toHaveLength(expected.length);
    rows.forEach((row, index) => {
      const cells = within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
      expect(cells).toEqual(
        expected[index]!.map((cell) => (cell === null ? "(missing)" : String(cell))),
      );
    });
    expect(table.querySelector("caption")?.textContent).toContain("missing observations, not zero");
  });

  test("toggling Run A only changes the view; exports stay whole and the filtered export is named", async () => {
    const before = structuredClone(REPRESENTATIVE_BAR_CHART);
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Run A" }));
    expect(screen.getByRole("button", { name: "Run A" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(
      marks(container, "bar").every((element) => element.getAttribute("data-series") === "b"),
    ).toBe(true);
    expect(REPRESENTATIVE_BAR_CHART).toEqual(before);
    expect(useRichContentViewStore.getState().entries.get(VIEW_KEY)?.hiddenSeries).toEqual(["a"]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy CSV" }));
    });
    expect(mockWriteText).toHaveBeenCalledWith(chartToCsv(REPRESENTATIVE_BAR_CHART));

    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const full = await downloads.at(-1)!.blob.text();
    expect(full).toContain("Run A");

    const filtered = screen.getByRole("button", { name: /visible series only \(filtered\)/ });
    fireEvent.click(filtered);
    const filteredDownload = downloads.at(-1)!;
    expect(filteredDownload.filename).toContain("filtered");
    expect(await filteredDownload.blob.text()).not.toContain("Run A");

    fireEvent.click(screen.getByRole("button", { name: "Reset view" }));
    expect(marks(container, "bar")).toHaveLength(6);
  });

  test("CSV and JSON exports preserve the exact values", async () => {
    renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    const csv = await downloads.at(-1)!.blob.text();
    expect(csv.replace(new RegExp("^\\ufeff"), "")).toBe(chartToCsv(REPRESENTATIVE_BAR_CHART));
    expect(csv).toContain("browser,Browser,b,Run B,\r\n");
    expect(csv).toContain("unit,Unit,b,Run B,44\r\n");

    fireEvent.click(screen.getByRole("button", { name: "Download JSON specification" }));
    const json = downloads.at(-1)!;
    expect(json.filename).toBe("Illustrative test outcomes.json");
    expect(await json.blob.text()).toBe(source);
    expect(JSON.parse(await json.blob.text())).toEqual(REPRESENTATIVE_BAR_CHART);
  });

  test("SVG export is self-contained and passes the export sanitizer (never offered unsanitized)", async () => {
    mockToastError.mockClear();
    renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Download SVG" }));
    if (!svgSanitizerUsableHere()) {
      // happy-dom's SVG DOM does not satisfy DOMPurify, so the sanitizer
      // refuses; the export must then fail visibly rather than skip the policy.
      expect(downloads).toHaveLength(0);
      expect(mockToastError).toHaveBeenCalled();
      return;
    }
    const svg = await downloads.at(-1)!.blob.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain("Illustrative test outcomes");
    expect(svg).toContain('viewBox="0 0 640 360"');
    expect(svg).not.toMatch(/<script|href=|url\(http/i);
  });

  test("the unsanitized scene SVG is self-contained with a title, description and both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const svg = chartSceneToSvg(buildChartScene(REPRESENTATIVE_BAR_CHART), theme);
      expect(svg).toContain("<title>Illustrative test outcomes</title>");
      expect(svg).toContain("<desc>");
      expect(svg).toContain('width="640" height="360" viewBox="0 0 640 360"');
      expect(svg).not.toMatch(/<script|href=|url\(|@import|<image/i);
    }
  });

  test("keyboard focus reaches exact values with a visible focused marker", () => {
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART, source);
    const svg = container.querySelector("svg[data-chart-kind]") as SVGSVGElement;
    expect(svg.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    const tooltip = container.querySelector('[data-chart-tooltip="true"]');
    expect(tooltip?.textContent).toContain("Run A");
    expect(tooltip?.textContent).toContain("Unit: 40 tests");
    expect(container.querySelector("[data-chart-focus]")).not.toBeNull();
    fireEvent.keyDown(svg, { key: "End" });
    expect(container.querySelector('[data-chart-tooltip="true"]')?.textContent).toContain(
      "Browser: missing",
    );
    // Only the chart itself is a tab stop, not every mark.
    expect(container.querySelectorAll("svg [tabindex]")).toHaveLength(0);
  });

  test("an empty visible selection shows a reset action", () => {
    renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Run A" }));
    fireEvent.click(screen.getByRole("button", { name: "Run B" }));
    expect(screen.getByText(/All series are hidden/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Reset view" }).at(-1)!);
    expect(screen.queryByText(/All series are hidden/) === null).toBe(true);
  });

  test("source view shows the exact authored JSON", () => {
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART, source);
    fireEvent.click(screen.getByRole("button", { name: "Source JSON" }));
    expect(container.querySelector('[data-chart-source-view="true"]')?.textContent).toBe(source);
  });
});

describe("NativeChart — every kind", () => {
  test("bar with negatives draws below the baseline", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "bar",
      title: "Deltas",
      description: "",
      xAxis: { kind: "category", label: "Week" },
      yAxis: { label: "Change" },
      categories: [
        { id: "w1", label: "W1" },
        { id: "w2", label: "W2" },
      ],
      series: [
        {
          id: "s",
          label: "Delta",
          points: [
            { categoryId: "w1", value: -5 },
            { categoryId: "w2", value: 5 },
          ],
        },
      ],
    };
    const { container } = renderChart(spec);
    const baseline = Number(
      container.querySelector('[data-chart-baseline="true"]')!.getAttribute("y1"),
    );
    const negative = bar(container, "s", "w1");
    const positive = bar(container, "s", "w2");
    expect(Number(negative.getAttribute("y"))).toBeCloseTo(baseline, 1);
    expect(
      Number(positive.getAttribute("y")) + Number(positive.getAttribute("height")),
    ).toBeCloseTo(baseline, 1);
  });

  test("bar with no categories renders an empty plot, and long labels are truncated with the full label kept", () => {
    const longLabel = "A".repeat(CHART_POLICY.maxLabelCharacters);
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "bar",
      title: "Long",
      description: "",
      xAxis: { kind: "category", label: longLabel },
      yAxis: { label: "V" },
      categories: [{ id: "c", label: longLabel }],
      series: [{ id: "s", label: longLabel, points: [{ categoryId: "c", value: 1 }] }],
    };
    const { container } = renderChart(spec);
    const labels = Array.from(container.querySelectorAll('[data-part="axes"] text'));
    const category = labels.find(
      (element) => element.querySelector("title")?.textContent === longLabel,
    )!;
    expect(category.lastChild?.textContent?.length ?? 0).toBeLessThan(longLabel.length);
    cleanup();
    const empty = renderChart({
      ...spec,
      categories: [],
      series: [{ id: "s", label: "S", points: [] }],
    });
    expect(marks(empty.container, "bar")).toHaveLength(0);
  });

  test("line null gaps split the stroke, constant domains render, and UTC boundaries format exactly", () => {
    const start = Date.UTC(1999, 11, 31, 23, 59, 59);
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "line",
      title: "Gap",
      description: "",
      xAxis: { kind: "utc-time", label: "Time" },
      yAxis: { label: "Value" },
      series: [
        {
          id: "s",
          label: "Series",
          points: [
            { x: start, y: 5 },
            { x: start + 1_000, y: null },
            { x: start + 2_000, y: 5 },
            { x: start + 3_000, y: 5 },
          ],
        },
      ],
    };
    const { container } = renderChart(spec);
    expect(marks(container, "segment")).toHaveLength(2);
    expect(marks(container, "point")).toHaveLength(3);
    const svg = container.querySelector("svg[data-chart-kind]") as SVGSVGElement;
    fireEvent.keyDown(svg, { key: "ArrowRight" });
    expect(container.querySelector('[data-chart-tooltip="true"]')?.textContent).toContain(
      "1999-12-31 23:59:59 UTC",
    );
    fireEvent.click(screen.getByRole("button", { name: "Data view" }));
    expect(screen.getByRole("columnheader", { name: "x_utc" })).toBeTruthy();
    expect(screen.getByText("2000-01-01T00:00:00.000Z")).toBeTruthy();
  });

  test("area closes each nonnull run to the zero baseline", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "area",
      title: "Area",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 3 },
            { x: 2, y: null },
            { x: 3, y: 2 },
          ],
        },
      ],
    };
    const { container } = renderChart(spec);
    expect(marks(container, "area")).toHaveLength(2);
    expect(container.querySelector('[data-chart-baseline="true"]')).not.toBeNull();
  });

  test("scatter keeps coincident points in the plot and in the data view", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "scatter",
      title: "Scatter",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [
        {
          id: "s",
          label: "S",
          points: [
            { x: 1, y: -2 },
            { x: 1, y: -2 },
            { x: 3, y: 4 },
          ],
        },
      ],
    };
    const { container } = renderChart(spec);
    expect(marks(container, "point")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Data view" }));
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  test("donut: zero entries stay in the data view, a single positive slice is a full ring, all-zero is labelled empty", () => {
    const spec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "donut",
      title: "Share",
      description: "",
      valueLabel: "Count",
      slices: [
        { id: "a", label: "Alpha", value: 3 },
        { id: "b", label: "Beta", value: 0 },
      ],
    };
    const { container } = renderChart(spec);
    const arcs = marks(container, "arc");
    expect(arcs).toHaveLength(1);
    expect(arcs[0]!.getAttribute("data-full-ring")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Data view" }));
    expect(screen.getByRole("cell", { name: "Beta" })).toBeTruthy();
    cleanup();
    useRichContentViewStore.getState().reset();
    const empty = renderChart({
      ...spec,
      slices: spec.slices.map((slice) => ({ ...slice, value: 0 })),
    });
    expect(empty.getByText("No positive values")).toBeTruthy();
    cleanup();
    const none = renderChart({ ...spec, slices: [] });
    expect(none.getByText("No positive values")).toBeTruthy();
  });

  test("maximum permitted sizes render every mark", () => {
    const categories = Array.from({ length: CHART_POLICY.maxBarCategories }, (_, index) => ({
      id: `c${index}`,
      label: `C${index}`,
    }));
    const series = Array.from({ length: CHART_POLICY.maxSeries }, (_, s) => ({
      id: `s${s}`,
      label: `S${s}`,
      points: categories.map((category, index) => ({
        categoryId: category.id,
        value: index * (s + 1),
      })),
    }));
    const barSpec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "bar",
      title: "Max",
      description: "",
      xAxis: { kind: "category", label: "c" },
      yAxis: { label: "v" },
      categories,
      series,
    };
    const { container } = renderChart(barSpec);
    expect(marks(container, "bar")).toHaveLength(
      CHART_POLICY.maxBarCategories * CHART_POLICY.maxSeries,
    );
    cleanup();
    const perSeries = CHART_POLICY.maxCartesianPoints / 2;
    const lineSpec: ChartSpecV1 = {
      schemaVersion: 1,
      kind: "line",
      title: "Max line",
      description: "",
      xAxis: { kind: "number", label: "x" },
      yAxis: { label: "y" },
      series: [0, 1].map((s) => ({
        id: `s${s}`,
        label: `S${s}`,
        points: Array.from({ length: perSeries }, (_, index) => ({
          x: index,
          y: Math.sin(index) * 1e15,
        })),
      })),
    };
    const line = renderChart(lineSpec);
    expect(marks(line.container, "point")).toHaveLength(CHART_POLICY.maxCartesianPoints);
  });
});

describe("ChartFenceBlock", () => {
  const source = JSON.stringify(REPRESENTATIVE_BAR_CHART);

  test("never parses a streaming fence", () => {
    const { container } = render(
      <ChartFenceBlock source={source.slice(0, 40)} closed={false} blockKey="k" />,
    );
    expect(container.querySelector("svg[data-chart-kind]") === null).toBe(true);
    expect(container.querySelector('[data-chart-source-view="true"]')?.textContent).toBe(
      source.slice(0, 40),
    );
    expect(container.querySelector('[role="note"]') === null).toBe(true);
  });

  test("renders a closed fence as an inline chart without publication authority", () => {
    const { container } = render(<ChartFenceBlock source={source} closed blockKey="k" />);
    expect(container.querySelector('svg[data-chart-kind="bar"]')).not.toBeNull();
    expect(container.querySelector('[data-chart-provenance="inline"]')?.textContent).toBe(
      "Inline chart from message text",
    );
    expect(screen.queryByText(/Published/) === null).toBe(true);
  });

  test("malformed specs report field paths and keep the raw source", () => {
    const bad = JSON.parse(source) as Record<string, unknown> & {
      series: Array<{ points: Array<Record<string, unknown>> }>;
    };
    bad.series[0]!.points[2]!.value = "8";
    (bad as Record<string, unknown>).options = { formatter: "function(){}" };
    const text = JSON.stringify(bad);
    const { container } = render(<ChartFenceBlock source={text} closed blockKey="k" />);
    const note = container.querySelector('[role="note"]')!;
    expect(note.textContent).toContain("series[0].points[2].value");
    expect(note.textContent).toContain("options");
    expect(container.querySelector('[data-chart-source-view="true"]')?.textContent).toBe(text);
    expect(container.querySelector("svg[data-chart-kind]") === null).toBe(true);
  });

  test("invalid JSON reports a location instead of throwing", () => {
    const { container } = render(
      <ChartFenceBlock source={'{"schemaVersion": 1,'} closed blockKey="k" />,
    );
    expect(container.querySelector('[role="note"]')?.textContent).toContain("invalid");
  });

  test("no network request, evaluation or markup can originate from a chart spec", () => {
    const fetchSpy = spyOn(globalThis, "fetch");
    const hostile = {
      ...REPRESENTATIVE_BAR_CHART,
      title: '<img src="https://example.invalid/x.png" onerror="alert(1)">',
      description: "javascript:alert(1)",
      categories: REPRESENTATIVE_BAR_CHART.categories.map((category) => ({
        ...category,
        label: `<script>fetch("https://example.invalid")</script>${category.label}`,
      })),
      yAxis: { label: "url(https://example.invalid/a.png)" },
    };
    const { container } = render(
      <ChartFenceBlock source={JSON.stringify(hostile)} closed blockKey="k" />,
    );
    expect(container.querySelector('svg[data-chart-kind="bar"]')).not.toBeNull();
    expect(
      container.querySelectorAll("img, script, a, iframe, foreignObject, image, use"),
    ).toHaveLength(0);
    expect(
      Array.from(container.querySelectorAll("*")).some((element) =>
        element.hasAttribute("onerror"),
      ),
    ).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("NativeChart — pin displacement", () => {
  test("a displaced expanded chart offers Reopen, which restores its dialog and hidden series", () => {
    const { container } = renderChart(REPRESENTATIVE_BAR_CHART);
    fireEvent.click(screen.getByRole("button", { name: "Run A" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand chart" }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    act(() => {
      for (let index = 0; index < FRONTEND_RENDER_POLICY.maxPinnedViewStateEntries; index++)
        pinRichViewWithRecovery(`other-chart-${index}`);
    });
    expect(screen.queryByRole("dialog") === null).toBe(true);
    const notice = container.querySelector("[data-rich-pin-displaced]") as HTMLElement;
    expect(notice.textContent).toContain("expanded chart was closed");

    // Even if the unprotected entry is evicted, Reopen restores the captured view.
    act(() => useRichContentViewStore.getState().clearPrefixes([VIEW_KEY]));
    fireEvent.click(within(notice).getByRole("button", { name: /Reopen/ }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Run A" }).getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(container.querySelector("[data-rich-pin-displaced]") === null).toBe(true);
  });
});
