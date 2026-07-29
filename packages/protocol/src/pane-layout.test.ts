import { describe, expect, test } from "bun:test";
import {
  isPaneLayoutRevisionConflict,
  PANE_LAYOUT_REVISION_CONFLICT_MARKER,
  paneLayoutRevisionConflictMessage,
} from "./pane-layout";

describe("paneLayoutRevisionConflictMessage", () => {
  test("names both revisions and leads with the shared marker", () => {
    const message = paneLayoutRevisionConflictMessage(3, 7);

    expect(message).toBe("Pane layout revision conflict: expected 3, current 7");
    expect(message.startsWith(PANE_LAYOUT_REVISION_CONFLICT_MARKER)).toBe(true);
    expect(isPaneLayoutRevisionConflict(new Error(message))).toBe(true);
  });
});

describe("isPaneLayoutRevisionConflict", () => {
  test("recognizes the message each transport actually delivers", () => {
    const raw = paneLayoutRevisionConflictMessage(1, 2);

    // Gateway path: apps/backend/src/gateway.ts returns { error: message } and
    // the browser client rethrows it verbatim.
    expect(isPaneLayoutRevisionConflict(new Error(raw))).toBe(true);
    // Electron path: ipcRenderer.invoke re-wraps a rejected handler error, so
    // the marker is no longer at the start of the message.
    expect(isPaneLayoutRevisionConflict(new Error(
      `Error invoking remote method 'orkestrator:invoke': Error: ${raw}`,
    ))).toBe(true);
  });

  test("does not fire for other failures or non-errors", () => {
    expect(isPaneLayoutRevisionConflict(new Error("Environment not found: env-1")))
      .toBe(false);
    expect(isPaneLayoutRevisionConflict(new Error("Pane layout root exceeds the 256 KB limit")))
      .toBe(false);
    // A bare marker with no revisions still counts: the retry path only needs
    // to know the save lost a race, not by how much.
    expect(isPaneLayoutRevisionConflict(new Error(PANE_LAYOUT_REVISION_CONFLICT_MARKER)))
      .toBe(true);
    // Anything that is not an Error carries no message to match against.
    expect(isPaneLayoutRevisionConflict(paneLayoutRevisionConflictMessage(1, 2)))
      .toBe(false);
    expect(isPaneLayoutRevisionConflict(null)).toBe(false);
    expect(isPaneLayoutRevisionConflict(undefined)).toBe(false);
    expect(isPaneLayoutRevisionConflict({ message: paneLayoutRevisionConflictMessage(1, 2) }))
      .toBe(false);
  });
});
