import { describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_CAPACITY,
  WEB_ANNOTATION_CONFLICT,
  WEB_ANNOTATION_DEGRADED,
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS,
  WEB_ANNOTATION_TARGET_KINDS,
  WEB_ANNOTATION_UNAVAILABLE,
  canTransitionWebAnnotationRequest,
  formatWebAnnotationError,
  normalizeWebAnnotationRolloutSettings,
  parseWebAnnotationError,
  parseWebAnnotationRolloutOverride,
  stripWebAnnotationErrorTrailer,
} from "./web-annotations.js";

describe("typed web annotation errors", () => {
  test("round-trip a capacity failure with usage totals behind the stable prefix", () => {
    const message = formatWebAnnotationError(
      `${WEB_ANNOTATION_CAPACITY} environment has 2000 of 2000 annotations`,
      { code: "capacity", resource: "annotations", used: 2000, limit: 2000, requested: 1 },
    );
    expect(message.startsWith(`${WEB_ANNOTATION_CAPACITY} environment has`)).toBe(true);
    const parsed = parseWebAnnotationError(new Error(message));
    expect(parsed.detail).toEqual({
      code: "capacity",
      resource: "annotations",
      used: 2000,
      limit: 2000,
      requested: 1,
    });
    expect(parsed.message).toBe(
      `${WEB_ANNOTATION_CAPACITY} environment has 2000 of 2000 annotations`,
    );
    expect(stripWebAnnotationErrorTrailer(message)).toBe(parsed.message);
    // Formatting twice never stacks trailers.
    expect(formatWebAnnotationError(message, { code: "capacity" })).toBe(
      `${parsed.message} [web-annotation-error {"code":"capacity"}]`,
    );
  });

  test("drops unknown codes, fields, and unsafe values from the trailer", () => {
    const message = formatWebAnnotationError("x", {
      code: "archived",
      continuationId: "annotation-1",
      // @ts-expect-error — not part of the contract
      text: "SECRET",
      used: -1,
    });
    expect(message).not.toContain("SECRET");
    expect(parseWebAnnotationError(message).detail).toEqual({
      code: "archived",
      continuationId: "annotation-1",
    });
    // @ts-expect-error — unknown code
    expect(formatWebAnnotationError("plain", { code: "made-up" })).toBe("plain");
    expect(
      parseWebAnnotationError('boom [web-annotation-error {"code":"nope"}]').detail,
    ).toBeNull();
    expect(
      parseWebAnnotationError(`x [web-annotation-error {"code":"capacity","resource":"../etc"}]`)
        .detail,
    ).toEqual({ code: "capacity" });
  });

  test("older messages without a trailer still classify by prefix", () => {
    expect(parseWebAnnotationError(`${WEB_ANNOTATION_CONFLICT} stale`).detail).toEqual({
      code: "conflict",
    });
    expect(parseWebAnnotationError(`${WEB_ANNOTATION_DEGRADED} unreadable`).detail?.code).toBe(
      "degraded",
    );
    expect(parseWebAnnotationError(`${WEB_ANNOTATION_UNAVAILABLE} off`).detail?.code).toBe(
      "disabled",
    );
    expect(parseWebAnnotationError("Something else").detail).toBeNull();
    expect(parseWebAnnotationError({ message: `${WEB_ANNOTATION_CAPACITY} x` }).detail?.code).toBe(
      "capacity",
    );
  });
});

describe("rollout settings", () => {
  test("normalize settings and parse the environment override", () => {
    expect(normalizeWebAnnotationRolloutSettings(undefined)).toEqual({ mode: "enabled" });
    expect(normalizeWebAnnotationRolloutSettings({ mode: "read-only" })).toEqual({
      mode: "read-only",
    });
    expect(normalizeWebAnnotationRolloutSettings({ mode: "sideways" })).toEqual({
      mode: "enabled",
    });
    expect(parseWebAnnotationRolloutOverride(undefined)).toBeNull();
    expect(parseWebAnnotationRolloutOverride(" READONLY ")).toBe("read-only");
    expect(parseWebAnnotationRolloutOverride("off")).toBe("disabled");
    expect(parseWebAnnotationRolloutOverride("1")).toBe("enabled");
    expect(parseWebAnnotationRolloutOverride("maybe")).toBeNull();
  });
});

describe("contract limits and targets", () => {
  test("entry pages hold 50 items, like list pages", () => {
    expect(WEB_ANNOTATION_LIMITS.entryPageItems).toBe(50);
    expect(WEB_ANNOTATION_LIMITS.listPageItems).toBe(50);
  });

  test("legacy targets stay readable but are never submittable", () => {
    expect(WEB_ANNOTATION_TARGET_KINDS).toContain("legacy-unresolved");
    expect(WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS).not.toContain("legacy-unresolved");
    expect([...WEB_ANNOTATION_SUBMITTABLE_TARGET_KINDS].sort()).toEqual(
      WEB_ANNOTATION_TARGET_KINDS.filter((kind) => kind !== "legacy-unresolved").sort(),
    );
  });
});

describe("request transition table", () => {
  test("a prepared request leaves only through publication or pre-publication settlement", () => {
    for (const next of ["dispatching", "running", "unconfirmed", "needs-input"] as const) {
      expect(canTransitionWebAnnotationRequest("prepared", next)).toBe(false);
    }
    for (const next of ["queued", "cancelled", "failed"] as const) {
      expect(canTransitionWebAnnotationRequest("prepared", next)).toBe(true);
    }
  });

  test("polling may observe forward skips from queued and dispatching", () => {
    for (const from of ["queued", "dispatching"] as const) {
      for (const to of [
        "running",
        "unconfirmed",
        "needs-input",
        "completed",
        "awaiting-review",
      ] as const) {
        expect(canTransitionWebAnnotationRequest(from, to)).toBe(true);
      }
    }
    // A claim released without dispatch returns to the queue.
    expect(canTransitionWebAnnotationRequest("dispatching", "queued")).toBe(true);
    // Never backwards into preparation.
    expect(canTransitionWebAnnotationRequest("queued", "prepared")).toBe(false);
  });

  test("unconfirmed reconciles to positive or terminal evidence, or same-id recovery", () => {
    for (const to of [
      "running",
      "needs-input",
      "completed",
      "awaiting-review",
      "failed",
      "abandoned-unconfirmed",
      "dispatching",
    ] as const) {
      expect(canTransitionWebAnnotationRequest("unconfirmed", to)).toBe(true);
    }
    expect(canTransitionWebAnnotationRequest("unconfirmed", "queued")).toBe(false);
    expect(canTransitionWebAnnotationRequest("unconfirmed", "cancelled")).toBe(false);
  });
});
