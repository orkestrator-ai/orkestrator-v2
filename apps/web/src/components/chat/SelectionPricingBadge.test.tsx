import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { SelectionPricingBadge } from "./SelectionPricingBadge";

afterEach(cleanup);

describe("SelectionPricingBadge", () => {
  test("renders the provider's label with its description as the tooltip", () => {
    render(
      <SelectionPricingBadge
        pricing={{ tier: "premium", label: "Max mode", description: "Bills at premium rates." }}
      />,
    );
    const badge = screen.getByTestId("composer-selection-pricing");
    expect(badge.textContent).toBe("Max mode");
    expect(badge.getAttribute("title")).toBe("Bills at premium rates.");
    expect(badge.getAttribute("aria-label")).toBe("Max mode: Bills at premium rates.");
  });

  test("falls back to a generic description", () => {
    render(<SelectionPricingBadge pricing={{ tier: "premium", label: "Priority" }} />);
    expect(screen.getByTestId("composer-selection-pricing").getAttribute("title")).toBe(
      "Priority bills at premium rates",
    );
  });

  test("renders nothing for a standard or unknown selection", () => {
    const { container } = render(<SelectionPricingBadge pricing={undefined} />);
    expect(container.innerHTML).toBe("");
  });
});
