import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { WORKFLOW_RESULT_KINDS } from "@orkestrator/protocol/workflow-results";
import { WorkflowResultStatus } from "./WorkflowResultStatus";

afterEach(cleanup);

describe("WorkflowResultStatus", () => {
  test("renders nothing when the backend has projected no submission state", () => {
    const { container } = render(<WorkflowResultStatus state={undefined} kind="review-report" />);
    expect(container.innerHTML).toBe("");
  });

  test("shows the four projected states with domain-appropriate wording", () => {
    render(<WorkflowResultStatus state="preparing" kind="review-report" />);
    expect(screen.getByText("Preparing report")).toBeDefined();
    cleanup();

    render(<WorkflowResultStatus state="correcting" kind="review-report" />);
    expect(screen.getByText("Correcting report format")).toBeDefined();
    cleanup();

    render(<WorkflowResultStatus state="received" kind="review-report" />);
    expect(screen.getByText("Report received; finishing checks")).toBeDefined();
    cleanup();

    render(<WorkflowResultStatus state="needs-attention" kind="feature-plan-state" />);
    expect(screen.getByText("Plan needs attention")).toBeDefined();
  });

  test("an accepted submission is not presented as a passing outcome", () => {
    render(<WorkflowResultStatus state="received" kind="verification-result" />);
    const status = screen.getByTestId("workflow-result-status");
    expect(status.dataset.state).toBe("received");
    expect(status.textContent).not.toContain("passed");
    expect(status.textContent).not.toContain("Complete");
    expect(status.className).not.toContain("emerald");
  });

  test("no receipt, digest, or key material reaches the rendered output", () => {
    for (const kind of WORKFLOW_RESULT_KINDS) {
      render(<WorkflowResultStatus state="received" kind={kind} />);
      const status = screen.getByTestId("workflow-result-status");
      expect(status.textContent ?? "").not.toMatch(/[0-9a-f]{16}/i);
      cleanup();
    }
  });
});
