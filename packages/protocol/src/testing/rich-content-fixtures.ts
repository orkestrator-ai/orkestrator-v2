/**
 * Synthetic rich-content fixtures shared by protocol, backend and renderer
 * tests. All values are illustrative test data, not project metrics.
 */
import type { BarChartSpecV1 } from "../chart-spec.js";

export const REPRESENTATIVE_BAR_CHART: BarChartSpecV1 = {
  schemaVersion: 1,
  kind: "bar",
  title: "Illustrative test outcomes",
  description: "Synthetic fixture: three suites, two recorded runs.",
  sourceNotes: ["All numbers are synthetic test data."],
  xAxis: { kind: "category", label: "Suite" },
  yAxis: { label: "Passed tests", unit: "tests" },
  categories: [
    { id: "unit", label: "Unit" },
    { id: "integration", label: "Integration" },
    { id: "browser", label: "Browser" },
  ],
  series: [
    {
      id: "a",
      label: "Run A",
      points: [
        { categoryId: "unit", value: 40 },
        { categoryId: "integration", value: 12 },
        { categoryId: "browser", value: 8 },
      ],
    },
    {
      id: "b",
      label: "Run B",
      points: [
        { categoryId: "unit", value: 44 },
        { categoryId: "integration", value: 12 },
        { categoryId: "browser", value: null },
      ],
    },
  ],
};
