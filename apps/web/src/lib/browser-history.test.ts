import { describe, expect, test } from "bun:test";
import {
  MAX_BROWSER_HISTORY_ENTRIES,
  boundBrowserHistory,
  sanitizeBrowserHistoryForPersistence,
} from "./browser-history";

describe("browser history persistence", () => {
  test("bounds entries and rebases or clamps the cursor", () => {
    const history = Array.from(
      { length: MAX_BROWSER_HISTORY_ENTRIES + 2 },
      (_, index) => `http://localhost/${index}`,
    );
    expect(boundBrowserHistory(history, history.length - 1)).toEqual({
      history: history.slice(2),
      historyIndex: MAX_BROWSER_HISTORY_ENTRIES - 1,
    });
    expect(boundBrowserHistory(undefined, 99, ["a", "b"])).toEqual({ history: undefined, historyIndex: 1 });
    expect(boundBrowserHistory(undefined, 1)).toEqual({ history: undefined });
    expect(boundBrowserHistory([], 0)).toEqual({ history: [], historyIndex: -1 });
  });

  test("redacts durable URL credentials and request-specific components", () => {
    expect(sanitizeBrowserHistoryForPersistence([
      "https://alice:secret@example.com/path?token=value#fragment",
      "opaque-internal-address",
    ])).toEqual([
      "https://example.com/path",
      "opaque-internal-address",
    ]);
  });
});
