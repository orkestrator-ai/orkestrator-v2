import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fixturePreviewService } from "@orkestrator/protocol/testing/preview-contract-fixtures";

import { invoke as nativeInvoke } from "@/lib/native/backend";
import { PreviewDiagnostics } from "./PreviewDiagnostics";

const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;

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

  test("route details name the owner and open copyable framework hints", async () => {
    invokeMock.mockImplementation(async (command: string) =>
      command === "get_preview_public_origin" ? { origin: "https://s-abc.preview.example" } : null,
    );
    const service = fixturePreviewService({
      definition: { targetKind: "worktree" },
    });
    render(
      <PreviewDiagnostics
        diagnosis={null}
        service={{
          ...service,
          endpoint: {
            ...service.endpoint,
            transportKind: "backend-loopback",
            ownership: "user-registered",
            listener: "unattributed",
          },
        }}
        transport={null}
        mode="desktop-tunnel"
        onAction={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Route details" }));
    expect(
      screen.getByText("user-registered · any process listening on this port is shown"),
    ).toBeTruthy();
    const toggle = screen.getByRole("button", { name: "Framework setup hints" });
    expect(screen.queryByTestId("preview-framework-hints") === null).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(screen.getByText(/^AUTH_URL=https:\/\/s-abc/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Copy the Vite snippet" })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("get_preview_public_origin", {
      serviceId: service.definition.serviceId,
    });
  });
});
