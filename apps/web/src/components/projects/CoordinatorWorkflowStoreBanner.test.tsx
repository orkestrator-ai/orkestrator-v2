import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { CoordinatorWorkflowStoreBanner } from "./CoordinatorPanelNotices";

afterEach(cleanup);

describe("CoordinatorWorkflowStoreBanner", () => {
  test("shows nothing while the store has room, or from a backend that does not say", () => {
    const { container, rerender } = render(<CoordinatorWorkflowStoreBanner state="ok" />);
    expect(container.innerHTML).toBe("");
    rerender(<CoordinatorWorkflowStoreBanner state={undefined} />);
    expect(container.innerHTML).toBe("");
  });

  test("warns near the limit and says what frees room", () => {
    render(<CoordinatorWorkflowStoreBanner state="near-limit" />);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Coordinator work records are nearly full.");
    expect(banner.textContent).toContain("Delete finished worker environments");
    expect(banner.textContent).not.toContain("Work panel");
    expect(
      banner
        .querySelector("[data-coordinator-workflow-store]")
        ?.getAttribute("data-coordinator-workflow-store"),
    ).toBe("near-limit");
  });

  test("alerts when full: launches are refused and messages will not wake the coordinator", () => {
    render(<CoordinatorWorkflowStoreBanner state="full" />);
    const banner = screen.getByRole("alert");
    expect(banner.textContent).toContain("Coordinator work records are full.");
    expect(banner.textContent).toContain("New launches are refused");
    expect(banner.textContent).toContain("will not wake the coordinator");
    expect(banner.textContent).toContain("Delete finished worker environments");
  });
});
