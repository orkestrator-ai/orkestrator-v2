import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { ESTIMATED_COST_TITLE, spokenCostText } from "@/lib/cost-source";
import { CostAmount } from "./CostAmount";

afterEach(() => {
  cleanup();
});

describe("CostAmount", () => {
  test("an estimate reads ~$0.12 with its tooltip, and says so to a screen reader", () => {
    render(<CostAmount amount="$0.12" source="estimate" />);
    const amount = screen.getByTitle(ESTIMATED_COST_TITLE);
    expect(amount.getAttribute("data-cost-source")).toBe("estimate");
    expect(amount.textContent).toBe("~$0.12, estimated");
    // The tilde is for the eye; the word is for the ear.
    expect(amount.querySelector("[aria-hidden='true']")?.textContent).toBe("~");
    expect(amount.querySelector(".sr-only")?.textContent).toBe(", estimated");
  });

  test("a provider-billed amount is the plain amount", () => {
    render(<CostAmount amount="$0.12" source="provider" />);
    const amount = screen.getByText("$0.12");
    expect(amount.textContent).toBe("$0.12");
    expect(amount.getAttribute("title")).toBeNull();
    expect(amount.getAttribute("data-cost-source")).toBe("provider");
  });

  test("an amount of unknown source is shown as costs always were", () => {
    render(<CostAmount amount="$0.12" source={undefined} />);
    const amount = screen.getByText("$0.12");
    expect(amount.getAttribute("title")).toBeNull();
    expect(amount.hasAttribute("data-cost-source")).toBe(false);
  });
});

describe("cost text", () => {
  test("marks only estimates", () => {
    expect(spokenCostText("$1.00", "estimate")).toBe("$1.00, estimated");
    expect(spokenCostText("$1.00", "provider")).toBe("$1.00");
    expect(spokenCostText("$1.00", undefined)).toBe("$1.00");
  });
});
