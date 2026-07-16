import { describe, expect, test } from "bun:test";
import { PANE_LAYOUT_VERSION } from "./models.js";

describe("backend pane layout model", () => {
  test("exports the supported persisted schema version at runtime", () => {
    expect(PANE_LAYOUT_VERSION).toBe(1);
  });
});
