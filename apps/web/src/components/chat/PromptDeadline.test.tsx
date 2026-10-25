import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PromptDeadline } from "./PromptDeadline";

afterEach(cleanup);

const inFourMinutes = () => Date.now() + 4 * 60_000 + 30_000;

describe("PromptDeadline", () => {
  test("without a published hold it is the plain countdown it always was", () => {
    render(<PromptDeadline expiresAt={inFourMinutes()} />);
    const countdown = screen.getByLabelText("Time remaining 4:30");
    expect(countdown.textContent).toBe("4:30");
    expect(countdown.tabIndex).toBe(-1);
    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("a pausable countdown is a toggle button that reports its state", () => {
    const onToggle = mock(() => undefined);
    render(
      <PromptDeadline
        expiresAt={inFourMinutes()}
        hold={{ available: true }}
        provider="claude"
        onToggle={onToggle}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Pause countdown, 4:30 left" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toBe("4:30");
    // The explanation is reachable without hovering.
    expect(document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Pause the countdown. Claude waits for your answer for up to 24 hours.",
    );
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  test("a paused countdown shows Paused, and the button resumes it", () => {
    const heldAt = Date.now();
    render(
      <PromptDeadline
        expiresAt={heldAt + 24 * 60 * 60_000}
        hold={{ available: true, heldAt }}
        held
        provider="claude"
        onToggle={() => undefined}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Resume countdown" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toBe("Paused");
  });

  test("a pause limited by the provider says when it still ends", () => {
    const heldAt = Date.now();
    render(
      <PromptDeadline
        expiresAt={heldAt + 20 * 60_000}
        hold={{ available: true, heldAt, reason: "provider-limit" }}
        held
        provider="grok"
        onToggle={() => undefined}
      />,
    );
    const toggle = screen.getByRole("button", { name: "Resume countdown" });
    expect(
      document.getElementById(toggle.getAttribute("aria-describedby")!)?.textContent,
    ).toContain("Grok stops waiting then, even while paused.");
  });

  test("a pause in flight disables the toggle", () => {
    render(
      <PromptDeadline
        expiresAt={inFourMinutes()}
        hold={{ available: true }}
        held
        pending
        onToggle={() => undefined}
      />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
  });

  test("an unpausable countdown is focusable text that explains why", () => {
    const cases = [
      [
        { available: false, reason: "bridge-outdated" } as const,
        "Pausing needs a newer agent bridge. Restart this environment to update it.",
      ],
      [
        { available: false, reason: "no-extension" } as const,
        "Codex stops waiting at this deadline itself, so it can't be paused.",
      ],
      [
        { available: false, reason: "hook-outdated" } as const,
        "This prompt came from a terminal hook that predates pausing. Prompts after Codex restarts can be paused.",
      ],
    ] as const;
    for (const [hold, text] of cases) {
      render(<PromptDeadline expiresAt={inFourMinutes()} hold={hold} provider="codex" />);
      expect(screen.queryByRole("button") === null).toBe(true);
      const countdown = screen.getByLabelText("Time remaining 4:30");
      expect(countdown.tabIndex).toBe(0);
      expect(
        document.getElementById(countdown.getAttribute("aria-describedby")!)?.textContent,
      ).toBe(text);
      cleanup();
    }
  });

  test("a pausable hold without a handler is not offered as a button", () => {
    render(<PromptDeadline expiresAt={inFourMinutes()} hold={{ available: true }} />);
    expect(screen.queryByRole("button") === null).toBe(true);
  });

  test("renders nothing without a deadline", () => {
    const { container } = render(<PromptDeadline hold={{ available: true }} />);
    expect(container.textContent).toBe("");
  });
});
