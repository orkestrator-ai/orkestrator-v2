import { afterEach, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import {
  PipelinePullRequestChecks,
  PipelinePullRequestView,
  pipelineCheckState,
  pipelineCheckSummary,
} from "./PipelinePullRequestView";

afterEach(cleanup);

test("failed checks take precedence over simultaneous pending checks", () => {
  const checks = { total: 4, passed: 2, pending: 1 };
  expect(pipelineCheckState(checks)).toBe("failing");
  expect(pipelineCheckSummary(checks)).toBe("2 of 4 checks passed · 1 failing · 1 pending");
  const { container } = render(<PipelinePullRequestChecks checks={checks} />);
  expect(container.querySelector('[data-pr-checks="failing"]')?.textContent).toContain(
    "CI failing",
  );
});

test("zero checks and unknown checks have explicit labels", () => {
  const { rerender, container } = render(
    <PipelinePullRequestChecks checks={{ total: 0, passed: 0, pending: 0 }} />,
  );
  expect(screen.getByText("No CI checks")).toBeTruthy();
  expect(container.querySelector("[data-pr-checks]") === null).toBe(true);
  expect(pipelineCheckSummary({ total: 0, passed: 0, pending: 0 })).toBe("No CI checks reported");
  rerender(<PipelinePullRequestChecks checks={null} />);
  expect(screen.getByText("CI status not known yet")).toBeTruthy();
});

test.each(["merged", "closed"] as const)("labels a %s PR alongside its CI summary", (state) => {
  render(
    <PipelinePullRequestView
      environmentId="test-pr-environment"
      shipped
      pullRequest={{
        url: "https://github.com/acme/app/pull/1",
        state,
        checks: { total: 4, passed: 2, pending: 1 },
      }}
    />,
  );
  expect(screen.getByTestId("pipeline-pr-state").textContent).toBe(
    state === "merged" ? "Merged" : "Closed",
  );
  expect(screen.getByTestId("pipeline-pr-checks").textContent).toContain("1 failing · 1 pending");
});
