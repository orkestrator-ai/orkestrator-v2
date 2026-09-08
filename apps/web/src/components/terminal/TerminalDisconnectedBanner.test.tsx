import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TerminalDisconnectedBanner } from "./TerminalDisconnectedBanner";

afterEach(() => {
  cleanup();
});

const MESSAGE = "This terminal's shell is no longer running, so it cannot accept input.";

describe("TerminalDisconnectedBanner", () => {
  it("announces the message through a polite live region", () => {
    render(
      <TerminalDisconnectedBanner message={MESSAGE} onReconnect={() => {}} onDismiss={() => {}} />,
    );

    const status = screen.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain(MESSAGE);
  });

  it("offers recovery, not just a report of the failure", () => {
    const onReconnect = mock(() => {});
    render(
      <TerminalDisconnectedBanner
        message={MESSAGE}
        onReconnect={onReconnect}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it("names the dismiss control for its action rather than the message text", () => {
    const onDismiss = mock(() => {});
    render(
      <TerminalDisconnectedBanner message={MESSAGE} onReconnect={() => {}} onDismiss={onDismiss} />,
    );

    // The whole sentence as an accessible name tells assistive technology
    // nothing about what activating the control does.
    const dismiss = screen.getByRole("button", { name: "Dismiss disconnected notice" });
    fireEvent.click(dismiss);

    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("keeps the two controls distinguishable from each other", () => {
    render(
      <TerminalDisconnectedBanner message={MESSAGE} onReconnect={() => {}} onDismiss={() => {}} />,
    );

    const names = screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    expect(names).toEqual([null, "Dismiss disconnected notice"]);
    expect(screen.getByRole("button", { name: "Reconnect" }).textContent).toBe("Reconnect");
  });
});
