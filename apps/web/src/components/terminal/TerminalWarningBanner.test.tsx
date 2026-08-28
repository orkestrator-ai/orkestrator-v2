import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalWarningBanner } from "./TerminalWarningBanner";

afterEach(() => {
  cleanup();
});

describe("TerminalWarningBanner", () => {
  it("announces the message through a polite live region", () => {
    render(
      <TerminalWarningBanner message="Terminal history was truncated." onDismiss={() => {}} />,
    );

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Terminal history was truncated.");
  });

  it("names the dismiss control for its action rather than the warning text", () => {
    render(
      <TerminalWarningBanner message="Terminal history was truncated." onDismiss={() => {}} />,
    );

    // The warning sentence must not become the button's accessible name: it
    // would tell assistive technology nothing about what activation does.
    expect(screen.queryByRole("button", { name: /Terminal history was truncated/i }) === null).toBe(
      true,
    );
    const control = screen.getByRole("button", { name: "Dismiss terminal warning" });
    expect(control.getAttribute("type")).toBe("button");
  });

  it("calls onDismiss once per activation", () => {
    const onDismiss = mock(() => {});
    render(
      <TerminalWarningBanner message="Saved history loaded too slowly." onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss terminal warning" }));

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders an empty message without collapsing the dismiss control", () => {
    render(<TerminalWarningBanner message="" onDismiss={() => {}} />);

    expect(screen.getByRole("status").textContent).toBe("");
    expect(screen.getByRole("button", { name: "Dismiss terminal warning" }).tagName).toBe("BUTTON");
  });
});
