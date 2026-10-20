import { expect, test } from "bun:test";
import { REPRESENTATIVE_BAR_CHART } from "@orkestrator/protocol/testing/rich-content-fixtures";
import { chartCsvExport, chartVisibleCsvExport } from "./artifact-chart-export";
test.each(["=HYPERLINK(1)", "+SUM(1)", "-1+2", "@SUM(1)"])(
  "downloaded chart labels neutralize %s",
  (label) => {
    const spec = {
      ...REPRESENTATIVE_BAR_CHART,
      categories: REPRESENTATIVE_BAR_CHART.categories.map((c, i) => ({
        ...c,
        label: i === 0 ? label : c.label,
      })),
    };
    expect(chartCsvExport(spec)).toContain("'" + label);
    expect(chartVisibleCsvExport(spec, new Set())).toContain("'" + label);
  },
);
