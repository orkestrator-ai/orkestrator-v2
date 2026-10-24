import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  createFakeCaptureApi,
  FakeWebAnnotationBackend,
  installFakeOrkestrator,
  invokeMock,
} from "@/test/web-annotation-fakes";
import { mockWriteText } from "../../../../../tests/mocks/clipboard";
import { WebAnnotationDiagnostics } from "./WebAnnotationDiagnostics";

const backendSnapshot = {
  counters: { "requests_created|operation=discuss": 3 },
  durations: {},
  gauges: {},
  droppedSeries: 0,
};
const desktopSnapshot = { spool: null, anchorResolutions: { "matched|stable-id": 2 } };
let bus: ReturnType<typeof installFakeOrkestrator>;
let backend: FakeWebAnnotationBackend;

describe("web annotation diagnostics loading and copying", () => {
  beforeEach(() => {
    backend = new FakeWebAnnotationBackend("env-1").install();
    backend.overrides.set("web_annotations_metrics", () => backendSnapshot);
    bus = installFakeOrkestrator({ capture: createFakeCaptureApi().api });
    mockWriteText.mockReset();
    mockWriteText.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    bus.restore();
    invokeMock.mockImplementation(() => Promise.resolve());
    mockWriteText.mockReset();
    mockWriteText.mockResolvedValue(undefined);
  });

  test("loads backend and optional desktop diagnostics asynchronously and copies the combined JSON", async () => {
    let resolveBackend!: (value: typeof backendSnapshot) => void;
    let resolveDesktop!: (value: typeof desktopSnapshot) => void;
    backend.overrides.set(
      "web_annotations_metrics",
      () =>
        new Promise((resolve) => {
          resolveBackend = resolve;
        }),
    );
    const getCaptureDiagnostics = mock(
      () =>
        new Promise((resolve) => {
          resolveDesktop = resolve;
        }),
    );
    Object.assign(window.orkestrator!.browserPreview!.capture!, { getCaptureDiagnostics });
    render(<WebAnnotationDiagnostics />);
    fireEvent.click(screen.getByRole("button", { name: "Load diagnostics" }));
    expect(
      (screen.getByRole("button", { name: "Load diagnostics" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    resolveBackend(backendSnapshot);
    await waitFor(() => expect(getCaptureDiagnostics).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("list") === null).toBe(true);
    resolveDesktop(desktopSnapshot);
    expect(await screen.findByText("Pins resolved on this desktop: 2 (2 matched)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy as JSON" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(mockWriteText).toHaveBeenCalledWith(
      JSON.stringify({ backend: backendSnapshot, desktop: desktopSnapshot }, null, 2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(screen.queryByRole("button", { name: "Copied" }) === null).toBe(true);
    // Finish the refresh to leave no unresolved component work.
    resolveBackend(backendSnapshot);
    await waitFor(() => expect(getCaptureDiagnostics).toHaveBeenCalledTimes(2));
    resolveDesktop(desktopSnapshot);
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Refresh" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
  });

  for (const desktop of ["absent", "failure"] as const) {
    test(`loads backend data when desktop diagnostics are ${desktop}`, async () => {
      if (desktop === "failure")
        Object.assign(window.orkestrator!.browserPreview!.capture!, {
          getCaptureDiagnostics: async () => {
            throw new Error("desktop offline");
          },
        });
      render(<WebAnnotationDiagnostics />);
      fireEvent.click(screen.getByRole("button", { name: "Load diagnostics" }));
      expect(await screen.findByText("Requests sent: 3")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Copy as JSON" }));
      await screen.findByRole("button", { name: "Copied" });
      expect(mockWriteText).toHaveBeenCalledWith(
        JSON.stringify({ backend: backendSnapshot, desktop: null }, null, 2),
      );
      expect(screen.queryByRole("alert") === null).toBe(true);
    });
  }

  test("shows backend load errors and allows retry, and reports clipboard failure", async () => {
    backend.overrides.set("web_annotations_metrics", () => {
      throw new Error("metrics offline");
    });
    render(<WebAnnotationDiagnostics />);
    fireEvent.click(screen.getByRole("button", { name: "Load diagnostics" }));
    expect((await screen.findByRole("alert")).textContent).toContain("metrics offline");
    expect(screen.queryByRole("button", { name: "Copy as JSON" }) === null).toBe(true);
    backend.overrides.set("web_annotations_metrics", () => backendSnapshot);
    fireEvent.click(screen.getByRole("button", { name: "Load diagnostics" }));
    await screen.findByText("Requests sent: 3");
    expect(screen.queryByRole("alert") === null).toBe(true);
    mockWriteText.mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "Copy as JSON" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Could not copy the diagnostics.");
  });
});
