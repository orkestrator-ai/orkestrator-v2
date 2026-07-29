import { describe, expect, test } from "bun:test";
import {
  COMPOSER_OCCUPIED_MESSAGE,
  composerOccupiedError,
  isComposeDraftOccupiedBackendError,
  isPromptQueueActionError,
  PromptQueueActionError,
} from "./prompt-queue-errors";

describe("prompt queue action errors", () => {
  test("carries user-facing guidance and the originating cause", () => {
    const cause = new Error("Compose draft already exists");
    const error = composerOccupiedError({ cause });

    expect(error.message).toBe(COMPOSER_OCCUPIED_MESSAGE);
    expect(error.message).toContain("Send or clear it");
    expect(error.cause).toBe(cause);
  });

  test("recognises an action error by prototype and by name", () => {
    expect(isPromptQueueActionError(composerOccupiedError())).toBe(true);
    expect(isPromptQueueActionError(new PromptQueueActionError("x"))).toBe(true);

    // A module boundary crossed by a test double loses the prototype but keeps
    // the name, and the dialog still has to show the specific message.
    const structural = new Error("x");
    structural.name = "PromptQueueActionError";
    expect(isPromptQueueActionError(structural)).toBe(true);
  });

  test("does not mistake an ordinary failure for actionable guidance", () => {
    expect(isPromptQueueActionError(new Error("Queue storage is unavailable")))
      .toBe(false);
    expect(isPromptQueueActionError("Compose draft already exists")).toBe(false);
    expect(isPromptQueueActionError(null)).toBe(false);
    expect(isPromptQueueActionError(undefined)).toBe(false);
  });

  test("detects the backend's occupied-draft refusal regardless of wrapping text", () => {
    expect(isComposeDraftOccupiedBackendError(new Error("Compose draft already exists")))
      .toBe(true);
    expect(isComposeDraftOccupiedBackendError(
      new Error("Backend command failed: compose draft already exists"),
    )).toBe(true);
    expect(isComposeDraftOccupiedBackendError(new Error("Compose draft revision conflict")))
      .toBe(false);
    expect(isComposeDraftOccupiedBackendError("Compose draft already exists"))
      .toBe(false);
  });
});
