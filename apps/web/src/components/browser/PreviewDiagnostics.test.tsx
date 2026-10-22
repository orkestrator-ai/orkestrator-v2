import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { fixturePreviewService } from "@orkestrator/protocol/testing/preview-contract-fixtures";

import { PreviewDiagnostics } from "./PreviewDiagnostics";

describe("preview diagnostics", () => {
  afterEach(cleanup);

  test("the route toggle keeps keyboard focus as it expands and collapses", () => {
    render(
      <PreviewDiagnostics
        diagnosis={null}
        service={fixturePreviewService()}
        transport={null}
        mode="desktop-tunnel"
        onAction={() => undefined}
      />,
    );
    const collapsed = screen.getByRole("button", { name: "Route details" });
    collapsed.focus();
    fireEvent.click(collapsed);
    // Expanding replaces the button; focus moves to the one that collapses.
    const expanded = screen.getByRole("button", { name: "Route" });
    expect(expanded.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(expanded);
    expect(screen.getByText("readiness")).toBeTruthy();

    fireEvent.click(expanded);
    const again = screen.getByRole("button", { name: "Route details" });
    expect(document.activeElement).toBe(again);
    expect(screen.queryByText("readiness") === null).toBe(true);
  });

  test("a pointer toggle does not pull focus from elsewhere", () => {
    render(
      <>
        <input aria-label="elsewhere" />
        <PreviewDiagnostics
          diagnosis={null}
          service={fixturePreviewService()}
          transport={null}
          mode="desktop-tunnel"
          onAction={() => undefined}
        />
      </>,
    );
    const elsewhere = screen.getByLabelText("elsewhere");
    elsewhere.focus();
    fireEvent.click(screen.getByRole("button", { name: "Route details" }));
    expect(document.activeElement).toBe(elsewhere);
  });
});
