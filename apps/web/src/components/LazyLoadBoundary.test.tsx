import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, type ReactNode } from "react";
import {
  isModuleLoadError,
  LazyDialogLoadingFallback,
  LazyLoadBoundary,
  LazyLoadInlineErrorFallback,
} from "./LazyLoadBoundary";

afterEach(() => {
  cleanup();
});

/**
 * React logs every boundary-caught error through console.error. Silence it for
 * the duration of a deliberate failure so the suite output stays readable, and
 * hand back whatever the callback returned.
 */
async function withSilencedReactErrors<T>(run: () => Promise<T> | T): Promise<T> {
  const originalError = console.error;
  console.error = mock(() => undefined) as typeof console.error;
  try {
    return await run();
  } finally {
    console.error = originalError;
  }
}

describe("isModuleLoadError", () => {
  test("recognizes bundler and browser chunk failures, not ordinary errors", () => {
    const chunkLoadError = new Error("boom");
    chunkLoadError.name = "ChunkLoadError";

    expect(isModuleLoadError(chunkLoadError)).toBe(true);
    expect(isModuleLoadError(new TypeError(
      "Failed to fetch dynamically imported module: https://host/assets/x-1234.js",
    ))).toBe(true);
    expect(isModuleLoadError(new Error(
      "error loading dynamically imported module",
    ))).toBe(true);
    expect(isModuleLoadError(new Error(
      "Importing a module script failed.",
    ))).toBe(true);

    expect(isModuleLoadError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isModuleLoadError("not an error")).toBe(false);
    expect(isModuleLoadError(undefined)).toBe(false);
  });
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
    const RejectedComponent = lazy(async () => {
      throw new Error("Failed to fetch dynamically imported module: /assets/x.js");
    });

    await withSilencedReactErrors(async () => {
      render(
        <div>
          <div>Application shell</div>
          <LazyLoadBoundary onReload={onReload}>
            <RejectedComponent />
          </LazyLoadBoundary>
        </div>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByText("This part of the app failed to load")).toBeTruthy();
      expect(screen.getByText("Application shell")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
      expect(onReload).toHaveBeenCalledTimes(1);
      // The message embeds the chunk URL, so it must never reach the DOM.
      expect(screen.queryByText(/assets\/x\.js/) === null).toBe(true);
    });
  });

  test("does not blame chunk loading when a loaded module throws while rendering", async () => {
    const Exploding = lazy(async () => ({
      default: () => {
        throw new Error("Cannot read properties of undefined (reading 'id')");
      },
    }));

    await withSilencedReactErrors(async () => {
      render(
        <LazyLoadBoundary>
          <Exploding />
        </LazyLoadBoundary>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByText("Something went wrong in this view")).toBeTruthy();
      expect(screen.queryByText("This part of the app failed to load") === null).toBe(true);
      expect(screen.queryByText(/Cannot read properties/) === null).toBe(true);
    });
  });

  test("reloads the window by default", async () => {
    const reload = mock(() => undefined);
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, reload },
    });
    const RejectedComponent = lazy(async () => {
      throw new Error("ChunkLoadError");
    });

    try {
      await withSilencedReactErrors(async () => {
        render(
          <LazyLoadBoundary>
            <RejectedComponent />
          </LazyLoadBoundary>,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Reload application" }));
        expect(reload).toHaveBeenCalledTimes(1);
      });
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  test("renders the failure through a caller-supplied scoped surface", async () => {
    const RejectedComponent = lazy(async () => {
      throw new Error("Failed to fetch dynamically imported module: /assets/tab.js");
    });

    await withSilencedReactErrors(async () => {
      render(
        <LazyLoadBoundary
          renderError={(details) => (
            <LazyLoadInlineErrorFallback {...details} isVisible={false} />
          )}
        >
          <RejectedComponent />
        </LazyLoadBoundary>,
      );

      const alert = await screen.findByRole("alert");
      // A hidden tab must not take the whole application down with it: the
      // scoped surface stays inside its positioned ancestor and hides.
      const container = alert.parentElement!;
      expect(container.className).toContain("absolute");
      expect(container.className).toContain("hidden");
      expect(container.className).not.toContain("fixed");
    });
  });

  test("scopes an inline failure to its container and stays visible when active", () => {
    const onReload = mock(() => undefined);
    render(
      <LazyLoadInlineErrorFallback
        isModuleLoadError
        onReload={onReload}
        isVisible
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.parentElement!.className).toContain("absolute");
    expect(alert.parentElement!.className).not.toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  test("renders a blocking dialog loading status", () => {
    render(<LazyDialogLoadingFallback label="Loading settings…" />);

    expect(
      screen.getByRole("status", { name: "Loading settings…" }),
    ).toBeTruthy();
  });
});
