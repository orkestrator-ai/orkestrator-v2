import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, type ReactNode } from "react";
import {
  LazyDialogLoadingFallback,
  LazyLoadBoundary,
} from "./LazyLoadBoundary";

afterEach(() => {
  cleanup();
});

describe("LazyLoadBoundary", () => {
  test("shows the supplied fallback while a lazy component is pending", () => {
    const PendingComponent = lazy(
      () => new Promise<{ default: () => ReactNode }>(() => {}),
    );

    render(
      <LazyLoadBoundary loadingFallback={<div>Loading feature…</div>}>
        <PendingComponent />
      </LazyLoadBoundary>,
    );

    expect(screen.getByText("Loading feature…")).toBeTruthy();
  });

  test("keeps the shell mounted and offers recovery when a lazy load rejects", async () => {
    const onReload = mock(() => undefined);
    const originalError = console.error;
    console.error = mock(() => undefined) as typeof console.error;
    const RejectedComponent = lazy(async () => {
      throw new Error("chunk unavailable");
    });

    try {
      render(
        <div>
          <div>Application shell</div>
          <LazyLoadBoundary onReload={onReload}>
            <RejectedComponent />
          </LazyLoadBoundary>
        </div>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByText("Application shell")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
      expect(onReload).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("chunk unavailable")).toBeNull();
    } finally {
      console.error = originalError;
    }
  });

  test("renders a blocking dialog loading status", () => {
    render(<LazyDialogLoadingFallback label="Loading settings…" />);

    expect(
      screen.getByRole("status", { name: "Loading settings…" }),
    ).toBeTruthy();
  });
});
