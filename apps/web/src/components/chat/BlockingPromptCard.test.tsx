import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
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

  test("presents pending and submitting states without announcing countdown ticks", () => {
    const { rerender } = render(
      <BlockingPromptCard
        title="Approval required"
        expiresAt={Date.now() + 65_000}
        arrivalAnnouncement="A new approval is waiting."
        actions={<Button>Dismiss</Button>}
      >
        Approve command?
      </BlockingPromptCard>,
    );

    const group = screen.getByRole("group", { name: "Approval required" });
    expect(group.getAttribute("aria-busy")).toBeNull();
    const countdown = screen.getByLabelText("Time remaining 1:05");
    expect(countdown.getAttribute("aria-live")).toBe("off");
    expect(screen.getByRole("status").textContent).toBe("A new approval is waiting.");

    rerender(
      <BlockingPromptCard title="Approval required" state="submitting">
        Approve command?
      </BlockingPromptCard>,
    );
    expect(screen.getByRole("group", { name: "Approval required" }).getAttribute("aria-busy"))
      .toBe("true");
  });

  test.each([
    ["expired" as const, /expired and was declined/i],
    ["withdrawn" as const, /withdrawn/i],
    ["stale" as const, /resolved elsewhere/i],
    ["invalid" as const, /invalid deadline/i],
  ])("renders the %s terminal outcome without actionable controls", (state, message) => {
    render(
      <BlockingPromptCard
        title="Approval required"
        state={state}
        actions={<Button>Dismiss</Button>}
      >
        Approve command?
      </BlockingPromptCard>,
    );

    const outcome = screen.getAllByRole("status").find((node) => message.test(node.textContent ?? ""));
    expect(outcome).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  test("shows a retryable inline error and invokes retry and dismissal actions", () => {
    const retry = mock(() => {});
    const dismiss = mock(() => {});
    render(
      <BlockingPromptCard
        title="Approval required"
        state="retryable-error"
        error="The provider is still waiting."
        onRetry={retry}
        actions={<Button onClick={dismiss}>Dismiss</Button>}
      >
        Approve command?
      </BlockingPromptCard>,
    );

    expect(screen.getByRole("alert").textContent).toContain("The provider is still waiting.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Dismiss" }).parentElement?.className)
      .toContain("flex-wrap");
  });
});
