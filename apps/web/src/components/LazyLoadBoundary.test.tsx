import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { lazy, type ReactNode } from "react";
import {
  createLazyLoadFailureDiagnostic,
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
  test("creates bounded diagnostics without retaining error or source text", () => {
    const diagnostic = createLazyLoadFailureDiagnostic(
      new TypeError(
        "secret transcript text at /Users/person/private/file.ts from https://host/assets/x.js",
      ),
      {
        componentStack: [
          "\n    at MultiReviewReviewerTab (file:///Users/person/private/view.tsx:10:2)",
          "    at MultiReviewTab (file:///Users/person/private/view.tsx:20:2)",
        ].join("\n"),
      },
    );

    expect(diagnostic).toEqual({
      kind: "render",
      errorType: "TypeError",
      fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/),
      componentChain: ["MultiReviewReviewerTab", "MultiReviewTab"],
    });
    const serialized = JSON.stringify(diagnostic);
    expect(serialized).not.toContain("secret transcript text");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("https://");
  });

  test("reports a non-Error throw distinctly from a real Error", () => {
    expect(createLazyLoadFailureDiagnostic("boom")).toEqual({
      kind: "render",
      errorType: "NonErrorThrow",
      fingerprint: expect.stringMatching(/^[a-f0-9]{8}$/),
      componentChain: [],
    });
    expect(createLazyLoadFailureDiagnostic(undefined).errorType).toBe("NonErrorThrow");
    expect(createLazyLoadFailureDiagnostic(new Error("boom")).errorType).toBe("Error");
  });

  test("collapses a custom error subclass to Error rather than echoing its name", () => {
    class SecretPathReadError extends Error {
      override name = "SecretPathReadError";
    }

    const diagnostic = createLazyLoadFailureDiagnostic(new SecretPathReadError("boom"));

    expect(diagnostic.errorType).toBe("Error");
    expect(JSON.stringify(diagnostic)).not.toContain("SecretPathReadError");
  });

  test("classifies a chunk failure as a module load rather than a render failure", () => {
    expect(createLazyLoadFailureDiagnostic(new TypeError(
      "Failed to fetch dynamically imported module: https://host/assets/x-1234.js",
    )).kind).toBe("module-load");
    expect(createLazyLoadFailureDiagnostic(new TypeError("undefined is not a function")).kind)
      .toBe("render");
  });

  test("bounds the component chain and drops lines that are not component names", () => {
    const diagnostic = createLazyLoadFailureDiagnostic(new Error("boom"), {
      componentStack: [
        "    at /Users/person/private/anonymous.tsx:1:1",
        "    at https://host/assets/chunk-1234.js:2:2",
        ...Array.from({ length: 20 }, (_, index) => `    at Component${index} (x.tsx:1:1)`),
      ].join("\n"),
    });

    expect(diagnostic.componentChain).toHaveLength(12);
    expect(diagnostic.componentChain[0]).toBe("Component0");
    expect(diagnostic.componentChain[11]).toBe("Component11");
    expect(JSON.stringify(diagnostic)).not.toContain("/Users/");
  });

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

  test("retries an ordinary render failure without reloading the application", async () => {
    let shouldThrow = true;
    const onReload = mock(() => undefined);
    const TransientFailure = () => {
      if (shouldThrow) throw new TypeError("transient transcript render failure");
      return <div>Recovered transcript</div>;
    };

    await withSilencedReactErrors(async () => {
      render(
        <LazyLoadBoundary onReload={onReload}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      shouldThrow = false;
      fireEvent.click(screen.getByRole("button", { name: "Retry view" }));
      expect(await screen.findByText("Recovered transcript")).toBeTruthy();
      expect(onReload).not.toHaveBeenCalled();
    });
  });

  test("retries a failed view when an authoritative reset key changes", async () => {
    let shouldThrow = true;
    const TransientFailure = () => {
      if (shouldThrow) throw new TypeError("transient transcript render failure");
      return <div>Recovered at the next revision</div>;
    };

    await withSilencedReactErrors(async () => {
      const view = render(
        <LazyLoadBoundary resetKeys={[1]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      shouldThrow = false;
      view.rerender(
        <LazyLoadBoundary resetKeys={[2]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );
      expect(await screen.findByText("Recovered at the next revision")).toBeTruthy();
    });
  });

  test("holds a failed view when the parent re-renders with equal reset keys", async () => {
    let shouldThrow = true;
    const TransientFailure = () => {
      if (shouldThrow) throw new TypeError("transient transcript render failure");
      return <div>Recovered at the next revision</div>;
    };

    await withSilencedReactErrors(async () => {
      // A fresh array literal on every parent render must not read as a change,
      // or a failed boundary would thrash on unrelated re-renders.
      const view = render(
        <LazyLoadBoundary resetKeys={[true, 0, 7]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      shouldThrow = false;
      view.rerender(
        <LazyLoadBoundary resetKeys={[true, 0, 7]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );

      expect(screen.getByRole("alert")).toBeTruthy();
      expect(screen.queryByText("Recovered at the next revision") === null).toBe(true);
    });
  });

  test("treats an appearing reset key and a changed key count as a reset", async () => {
    let shouldThrow = true;
    const TransientFailure = () => {
      if (shouldThrow) throw new TypeError("transient transcript render failure");
      return <div>Recovered at the next revision</div>;
    };

    await withSilencedReactErrors(async () => {
      // A workflow absent from the store selects `undefined`; its first
      // authoritative revision must recover the view.
      const view = render(
        <LazyLoadBoundary>
          <TransientFailure />
        </LazyLoadBoundary>,
      );

      expect(await screen.findByRole("alert")).toBeTruthy();
      shouldThrow = false;
      view.rerender(
        <LazyLoadBoundary resetKeys={[1]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );
      expect(await screen.findByText("Recovered at the next revision")).toBeTruthy();

      shouldThrow = true;
      view.rerender(
        <LazyLoadBoundary resetKeys={[1]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      shouldThrow = false;
      view.rerender(
        <LazyLoadBoundary resetKeys={[1, 2]}>
          <TransientFailure />
        </LazyLoadBoundary>,
      );
      expect(await screen.findByText("Recovered at the next revision")).toBeTruthy();
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
    const onRetry = mock(() => undefined);
    render(
      <LazyLoadInlineErrorFallback
        isModuleLoadError
        onReload={onReload}
        onRetry={onRetry}
        isVisible
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.parentElement!.className).toContain("absolute");
    expect(alert.parentElement!.className).not.toContain("hidden");
    fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Retry view" }) === null).toBe(true);
  });

  test("offers an inline retry for a render failure without reloading", () => {
    const onReload = mock(() => undefined);
    const onRetry = mock(() => undefined);
    render(
      <LazyLoadInlineErrorFallback
        isModuleLoadError={false}
        onReload={onReload}
        onRetry={onRetry}
        isVisible
      />,
    );

    // Every pane tab renders through this surface, so retry has to be reachable
    // here and not only on the app-level overlay.
    expect(screen.getByRole("alert").textContent).toContain("Retry this view");
    fireEvent.click(screen.getByRole("button", { name: "Retry view" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Reload application" }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  test("renders a blocking dialog loading status", () => {
    render(<LazyDialogLoadingFallback label="Loading settings…" />);

    expect(
      screen.getByRole("status", { name: "Loading settings…" }),
    ).toBeTruthy();
  });
});
