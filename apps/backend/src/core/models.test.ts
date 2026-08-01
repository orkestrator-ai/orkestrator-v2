import { describe, expect, test } from "bun:test";
import { PANE_LAYOUT_VERSION } from "./models.js";
import { PANE_LAYOUT_VERSION as SHARED_PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";

describe("backend pane layout model", () => {
  test("exports the supported persisted schema version at runtime", () => {
    expect(PANE_LAYOUT_VERSION).toBe(2);
    expect(PANE_LAYOUT_VERSION).toBe(SHARED_PANE_LAYOUT_VERSION);
  });
});
