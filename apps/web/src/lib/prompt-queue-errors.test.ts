import { describe, expect, test } from "bun:test";
import {
  COMPOSER_OCCUPIED_MESSAGE,
  composerOccupiedError,
  describePromptQueueActionError,
  isWebAnnotationQueueItemFrozenError,
  WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE,
  webAnnotationQueueItemFrozenError,
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
    expect(isPromptQueueActionError(new Error("Queue storage is unavailable"))).toBe(false);
    expect(isPromptQueueActionError("Compose draft already exists")).toBe(false);
    expect(isPromptQueueActionError(null)).toBe(false);
    expect(isPromptQueueActionError(undefined)).toBe(false);
  });

  test("detects the backend's occupied-draft refusal regardless of wrapping text", () => {
    expect(isComposeDraftOccupiedBackendError(new Error("Compose draft already exists"))).toBe(
      true,
    );
    expect(
      isComposeDraftOccupiedBackendError(
        new Error("Backend command failed: compose draft already exists"),
      ),
    ).toBe(true);
    expect(isComposeDraftOccupiedBackendError(new Error("Compose draft revision conflict"))).toBe(
      false,
    );
    expect(isComposeDraftOccupiedBackendError("Compose draft already exists")).toBe(false);
  });
});

describe("web annotation frozen queue items", () => {
  const frozen = new Error(
    "Web annotation queue item is frozen: item-1 is a frozen request snapshot; it cannot be edited or moved into a draft. Remove it to cancel the request.",
  );

  test("recognises the backend refusal by its stable prefix", () => {
    expect(isWebAnnotationQueueItemFrozenError(frozen)).toBe(true);
    expect(isWebAnnotationQueueItemFrozenError(`wrapped: ${frozen.message}`)).toBe(true);
    expect(isWebAnnotationQueueItemFrozenError(new Error("Prompt queue is busy"))).toBe(false);
    expect(isWebAnnotationQueueItemFrozenError(null)).toBe(false);
  });

  test("describes queue failures without leaking the raw refusal", () => {
    expect(describePromptQueueActionError(frozen)).toBe(WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE);
    expect(describePromptQueueActionError(webAnnotationQueueItemFrozenError())).toBe(
      WEB_ANNOTATION_QUEUE_ITEM_FROZEN_MESSAGE,
    );
    expect(describePromptQueueActionError(composerOccupiedError())).toBe(COMPOSER_OCCUPIED_MESSAGE);
    expect(describePromptQueueActionError(new Error("socket closed"))).toContain(
      "Could not confirm the prompt queue update",
    );
  });

  test("the frozen error is an actionable queue error", () => {
    const cause = new Error("raw");
    const error = webAnnotationQueueItemFrozenError({ cause });
    expect(isPromptQueueActionError(error)).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.message).toContain("Open the note");
  });
});
