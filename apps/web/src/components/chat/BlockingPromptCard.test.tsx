import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { BlockingPromptCard } from "./BlockingPromptCard";

afterEach(() => cleanup());

describe("BlockingPromptCard", () => {
  test("forwards role, accessible label, and supported data attributes", () => {
    render(
      <BlockingPromptCard
        role="alertdialog"
        aria-label="Approval required"
        data-testid="approval-card"
        data-session-id="session-1"
        data-client-url="http://127.0.0.1:4312"
      >
        Approve command?
      </BlockingPromptCard>,
    );

    const card = screen.getByRole("alertdialog", {
      name: "Approval required",
    });
    expect(card).toBe(screen.getByTestId("approval-card"));
    expect(card.getAttribute("data-session-id")).toBe("session-1");
    expect(card.getAttribute("data-client-url")).toBe("http://127.0.0.1:4312");
  });

  test("merges caller classes with the shared blocking treatment", () => {
    render(
      <BlockingPromptCard className="custom-card">
        Approve command?
      </BlockingPromptCard>,
    );

    const card = screen.getByText("Approve command?");
    expect(card.className).toContain("custom-card");
    expect(card.className).toContain("border-amber-500/40");
  });
});
