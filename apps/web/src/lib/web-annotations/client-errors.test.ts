import { describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_UNAVAILABLE,
  formatWebAnnotationError,
} from "@orkestrator/protocol/web-annotations";
import { fixtureCapabilities } from "@/test/web-annotation-fakes";
import {
  classifyWebAnnotationError,
  describeWebAnnotationError,
  isTransientWebAnnotationError,
  webAnnotationFeatures,
} from "./client";

describe("typed web annotation errors", () => {
  test("never show the machine trailer and describe each code", () => {
    const capacity = new Error(
      formatWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} thread is full`, {
        code: "capacity",
        resource: "thread-entries",
        used: 500,
        limit: 500,
        archivable: true,
      }),
    );
    const text = describeWebAnnotationError(capacity);
    expect(text).not.toContain("[web-annotation-error");
    expect(text).toContain("500 of 500");
    expect(text).toContain("Archive it and continue");
    expect(classifyWebAnnotationError(capacity)).toBe("capacity");

    const readOnly = new Error(
      formatWebAnnotationError(`${WEB_ANNOTATION_UNAVAILABLE} read-only`, {
        code: "read-only",
        mode: "read-only",
      }),
    );
    expect(describeWebAnnotationError(readOnly)).toMatch(/read-only/);
    expect(classifyWebAnnotationError(readOnly)).toBe("read-only");
    // Older backends: same prefix without a trailer still reads as read-only.
    expect(
      classifyWebAnnotationError(`${WEB_ANNOTATION_UNAVAILABLE} web annotations are read-only`),
    ).toBe("read-only");

    for (const code of [
      "upgrade-required",
      "unsupported-version",
      "archived",
      "disabled",
    ] as const) {
      const message = describeWebAnnotationError(
        formatWebAnnotationError("Web annotation failure", { code }),
      );
      expect(message).not.toContain("[web-annotation-error");
      expect(message.length).toBeGreaterThan(10);
    }
  });

  test("only untyped transport failures are retried automatically", () => {
    expect(isTransientWebAnnotationError(new Error("Gateway disconnected"))).toBe(true);
    expect(isTransientWebAnnotationError(new Error("fetch failed"))).toBe(true);
    expect(isTransientWebAnnotationError(new Error("Comment must not be empty"))).toBe(false);
    expect(
      isTransientWebAnnotationError(
        formatWebAnnotationError(`${WEB_ANNOTATION_CAPACITY} network`, { code: "capacity" }),
      ),
    ).toBe(false);
  });
});

describe("rollout-aware features", () => {
  test("read-only keeps reads, drafts, resolve and recovery, and nothing that creates work", () => {
    const features = webAnnotationFeatures(
      {
        ...fixtureCapabilities({
          author: false,
          captureAccept: false,
          dispatch: false,
          resolve: true,
          recover: true,
          archive: false,
        }),
        mode: "read-only",
      },
      true,
    );
    expect(features).toMatchObject({
      mode: "read-only",
      read: true,
      drafts: true,
      resolve: true,
      recover: true,
      author: false,
      capture: false,
      dispatch: false,
      archive: false,
    });
  });

  test("disabled turns every entry point off", () => {
    const features = webAnnotationFeatures({ ...fixtureCapabilities(), mode: "disabled" }, true);
    expect(features.mode).toBe("disabled");
    expect(features.read || features.author || features.drafts || features.recover).toBe(false);
  });

  test("an older backend without a mode derives resolve and recovery from its operations", () => {
    const features = webAnnotationFeatures(fixtureCapabilities(), true);
    expect(features).toMatchObject({ mode: "enabled", resolve: true, recover: true, drafts: true });
    expect(features.archive).toBe(false);
  });
});
