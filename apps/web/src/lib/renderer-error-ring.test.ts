import { describe, expect, test } from "bun:test";
import {
  MAX_RENDERER_ERROR_BATCH,
  parseRendererErrorEntry,
} from "@orkestrator/protocol/renderer-errors";
import { boundaryOf, RendererErrorRing, rendererErrorRoute } from "./renderer-error-ring";

const SECRET = "prompt text sk-ant-secret /Users/someone/project/file.ts";

function failure(message = SECRET, name = "TypeError"): Error {
  const error = new Error(message);
  error.name = name;
  error.stack = `${name}: ${message}\n    at render (/Users/someone/project/App.tsx:10:5)`;
  return error;
}

describe("the renderer error ring", () => {
  test("never stores a message or a stack, only the five content-free fields", () => {
    const ring = new RendererErrorRing();
    ring.record(failure(), "message-row", "window", "\n    at Row (/Users/someone/Row.tsx:1:1)");
    ring.record(SECRET, "rejection", "window");
    const stored = JSON.stringify(ring.entries());
    expect(stored).not.toContain("someone");
    expect(stored).not.toContain("secret");
    expect(stored).not.toContain("prompt");
    for (const entry of ring.entries()) {
      expect(Object.keys(entry).sort()).toEqual([
        "boundary",
        "count",
        "errorClass",
        "fingerprint",
        "route",
      ]);
      // The backend accepts exactly what the ring builds.
      expect(parseRendererErrorEntry(entry)).toEqual(entry);
    }
    expect(ring.entries().map((entry) => entry.errorClass)).toEqual(["TypeError", "NonErrorThrow"]);
  });

  test("a custom error class is recorded as Error", () => {
    const ring = new RendererErrorRing();
    ring.record(failure("x", `Leaked ${SECRET}`), "root", "window");
    expect(ring.entries()[0]?.errorClass).toBe("Error");
  });

  test("the same failure counts up; a different one is a new entry", () => {
    const ring = new RendererErrorRing();
    const error = failure();
    ring.record(error, "lazy-view", "window");
    ring.record(error, "lazy-view", "window");
    ring.record(error, "lazy-view", "browser");
    expect(ring.entries().map((entry) => [entry.route, entry.count])).toEqual([
      ["window", 2],
      ["browser", 1],
    ]);
  });

  test("is bounded, dropping the least recently seen", () => {
    const ring = new RendererErrorRing(3);
    const errors = [0, 1, 2, 3].map((index) => failure(`failure ${index}`));
    for (const error of errors.slice(0, 3)) ring.record(error, "boundary", "window");
    ring.record(errors[0], "boundary", "window");
    ring.record(errors[3], "boundary", "window");
    expect(ring.entries()).toHaveLength(3);
    expect(ring.entries().map((entry) => entry.count)).toEqual([1, 2, 1]);
  });

  test("new counts are taken once, a batch at a time, and can be put back", () => {
    const ring = new RendererErrorRing();
    for (let index = 0; index < MAX_RENDERER_ERROR_BATCH + 5; index += 1) {
      ring.record(failure(`failure ${index}`), "window", "window");
    }
    const first = ring.takeUnsent();
    expect(first).toHaveLength(MAX_RENDERER_ERROR_BATCH);
    expect(ring.takeUnsent()).toHaveLength(5);
    expect(ring.hasUnsent()).toBe(false);
    ring.restore(first.slice(0, 2));
    expect(ring.takeUnsent().map((entry) => entry.count)).toEqual([1, 1]);
  });
});

describe("where a failure was caught", () => {
  test("a boundary names itself; anything else is a boundary", () => {
    class Named {
      static readonly diagnosticBoundary = "rich-block";
    }
    class Other {
      static readonly diagnosticBoundary = "SettingsPage";
    }
    expect(boundaryOf(new Named())).toBe("rich-block");
    expect(boundaryOf(new Other())).toBe("boundary");
    expect(boundaryOf(undefined)).toBe("boundary");
  });

  test("the surface stands in for a route", () => {
    expect(rendererErrorRoute({})).toBe("window");
    expect(rendererErrorRoute({ orkestratorGateway: { enabled: true } })).toBe("browser");
    expect(rendererErrorRoute({ orkestratorGateway: { enabled: true, desktop: true } })).toBe(
      "window",
    );
    // Before a browser tab's gateway is installed: an HTTP page with no
    // desktop API that is not Electron.
    const page = (protocol: string, userAgent = "Mozilla/5.0 Safari") => ({
      location: { protocol },
      navigator: { userAgent },
    });
    expect(rendererErrorRoute(page("https:"))).toBe("browser");
    expect(rendererErrorRoute(page("http:", "Chrome Electron/41.0.0"))).toBe("window");
    expect(rendererErrorRoute(page("file:"))).toBe("window");
    expect(rendererErrorRoute({ ...page("http:"), orkestratorDesktopHost: {} })).toBe("window");
    expect(rendererErrorRoute({ ...page("http:"), orkestrator: {} })).toBe("window");
  });
});
