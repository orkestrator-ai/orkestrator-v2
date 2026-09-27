import { describe, expect, test } from "bun:test";
import {
  WEB_ANNOTATION_LIMITS,
  WEB_ANNOTATION_REQUEST_STATES,
  WEB_ANNOTATION_REQUEST_STATE_LABELS,
  canTransitionWebAnnotationRequest,
  isWebAnnotationRequestActive,
  webAnnotationPageKey,
  webAnnotationQueueOrigin,
  webAnnotationUtf8Bytes,
} from "./web-annotations.js";
import {
  assertNoDeclaredProvenance,
  isSafeRelativePath,
  isWebAnnotationTarget,
  sanitizeWebAnnotationUrl,
  validateWebAnnotationBody,
  validateWebAnnotationCaptureInput,
  validateWebAnnotationResultCaptureMetadata,
  validateWebAnnotationResultReport,
} from "./web-annotations-validation.js";
import {
  fixtureCapture,
  fixtureCaptureInput,
  fixtureRequestsByState,
  fixtureTargets,
} from "./web-annotations-fixtures.js";

describe("web annotation request lifecycle", () => {
  test("identity transitions are idempotent for every state", () => {
    for (const state of WEB_ANNOTATION_REQUEST_STATES) {
      expect(canTransitionWebAnnotationRequest(state, state)).toBe(true);
    }
  });

  test("terminal states never regress", () => {
    for (const terminal of ["completed", "awaiting-review", "failed", "cancelled"] as const) {
      for (const next of WEB_ANNOTATION_REQUEST_STATES) {
        if (next === terminal) continue;
        expect(canTransitionWebAnnotationRequest(terminal, next)).toBe(false);
      }
    }
  });

  test("unknown dispatch outcomes cannot become a fresh queue entry", () => {
    expect(canTransitionWebAnnotationRequest("unconfirmed", "queued")).toBe(false);
    expect(canTransitionWebAnnotationRequest("unconfirmed", "abandoned-unconfirmed")).toBe(true);
    expect(canTransitionWebAnnotationRequest("running", "queued")).toBe(false);
  });

  test("cancelling stays active until authoritative settlement", () => {
    expect(isWebAnnotationRequestActive("cancelling")).toBe(true);
    expect(isWebAnnotationRequestActive("unconfirmed")).toBe(true);
    expect(isWebAnnotationRequestActive("cancelled")).toBe(false);
  });

  test("every state has a fixture and a label", () => {
    const fixtures = fixtureRequestsByState();
    for (const state of WEB_ANNOTATION_REQUEST_STATES) {
      expect(fixtures[state].state).toBe(state);
      expect(WEB_ANNOTATION_REQUEST_STATE_LABELS[state].length).toBeGreaterThan(0);
      expect(fixtures[state].reservation).toBe(isWebAnnotationRequestActive(state));
    }
  });
});

describe("web annotation capture validation", () => {
  test("accepts every enabled capture fixture", () => {
    for (const kind of ["element", "text-range", "region", "page"] as const) {
      const result = validateWebAnnotationCaptureInput(fixtureCaptureInput(kind));
      expect(result).toEqual({ ok: true, value: fixtureCaptureInput(kind) });
    }
  });

  test("legacy targets are never accepted from a capture client", () => {
    const input = { ...fixtureCaptureInput(), target: fixtureTargets["legacy-unresolved"] };
    expect(validateWebAnnotationCaptureInput(input).ok).toBe(false);
    expect(fixtureCapture("legacy-unresolved").state).toBe("stale");
  });

  test("rejects non-finite geometry", () => {
    const input = fixtureCaptureInput();
    const target = { ...input.target, rect: { x: Number.NaN, y: 0, width: 1, height: 1 } };
    expect(validateWebAnnotationCaptureInput({ ...input, target }).ok).toBe(false);
    const geometry = { ...input.geometry!, zoomFactor: Number.POSITIVE_INFINITY };
    expect(validateWebAnnotationCaptureInput({ ...input, geometry }).ok).toBe(false);
  });

  test("rejects over-limit UTF-8 metadata before storage", () => {
    const input = fixtureCaptureInput();
    const evidence = {
      ...input.evidence!,
      attributes: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`data-${index}`, "😀".repeat(250)]),
      ),
      styles: Object.fromEntries(
        Array.from({ length: 48 }, (_, index) => [`--v-${index}`, "😀".repeat(150)]),
      ),
      html: "😀".repeat(4_000),
    };
    const result = validateWebAnnotationCaptureInput({ ...input, evidence });
    expect(result).toEqual({ ok: false, error: "Capture metadata exceeds 64 KiB" });
  });

  test("rejects duplicate asset ids and malformed ids", () => {
    const input = fixtureCaptureInput();
    expect(validateWebAnnotationCaptureInput({ ...input, assetIds: ["a", "a"] }).ok).toBe(false);
    expect(validateWebAnnotationCaptureInput({ ...input, assetIds: ["../x"] }).ok).toBe(false);
  });

  test("target validation honors enabled kinds", () => {
    expect(isWebAnnotationTarget(fixtureTargets.region, new Set(["element"]))).toBe(false);
    expect(isWebAnnotationTarget(fixtureTargets.region)).toBe(true);
  });
});

describe("web annotation provenance and bodies", () => {
  test("untrusted payloads cannot declare provenance", () => {
    expect(() => assertNoDeclaredProvenance({ body: "x", provenance: "host-user" })).toThrow(
      "Provenance is assigned by the receiver",
    );
    expect(() => assertNoDeclaredProvenance({ body: "x" })).not.toThrow();
  });

  test("bodies are multiline, non-blank, and bounded", () => {
    expect(validateWebAnnotationBody("a\r\nb")).toEqual({ ok: true, value: "a\nb" });
    expect(validateWebAnnotationBody("   ").ok).toBe(false);
    expect(validateWebAnnotationBody("x".repeat(WEB_ANNOTATION_LIMITS.entryChars + 1)).ok).toBe(
      false,
    );
  });

  test("utf8 byte counting matches the platform encoder", () => {
    for (const value of ["", "abc", "é", "😀", "a😀b\u0800", "\ud800"]) {
      expect(webAnnotationUtf8Bytes(value)).toBe(new TextEncoder().encode(value).length);
    }
  });
});

describe("web annotation result reports", () => {
  test("agent checks cannot claim app-observed provenance", () => {
    const result = validateWebAnnotationResultReport({
      requestId: "request-1",
      summary: "Adjusted padding",
      checks: [{ description: "tests", outcome: "passed", provenance: "app-observed" }],
    });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.value.checks[0]).toEqual({ description: "tests", outcome: "passed" });
  });

  test("result file paths must stay repository relative", () => {
    for (const file of ["/etc/passwd", "../secret", "a/../../b", "C:/x", "a\0b"]) {
      expect(isSafeRelativePath(file)).toBe(false);
      expect(
        validateWebAnnotationResultReport({ requestId: "r", summary: "s", files: [file] }).ok,
      ).toBe(false);
    }
    expect(isSafeRelativePath("apps/web/src/Button.tsx")).toBe(true);
  });

  test("missing check outcomes never default to passed", () => {
    expect(
      validateWebAnnotationResultReport({
        requestId: "r",
        summary: "s",
        checks: [{ description: "tests" }],
      }).ok,
    ).toBe(false);
  });

  test("evidence ids are bounded opaque ids, deduplicated", () => {
    const result = validateWebAnnotationResultReport({
      requestId: "r",
      summary: "s",
      evidenceIds: ["capture-1", "asset-1", "capture-1"],
    });
    expect(result.ok && result.value.evidenceIds).toEqual(["capture-1", "asset-1"]);
    expect(
      validateWebAnnotationResultReport({ requestId: "r", summary: "s", evidenceIds: ["../x"] }).ok,
    ).toBe(false);
    expect(
      validateWebAnnotationResultReport({
        requestId: "r",
        summary: "s",
        evidenceIds: Array.from({ length: 51 }, (_, index) => `id-${index}`),
      }).ok,
    ).toBe(false);
  });
});

describe("web annotation result capture metadata", () => {
  test("accepts the desktop's optional fields and keeps only known ones", () => {
    const result = validateWebAnnotationResultCaptureMetadata({
      environmentId: "ignored",
      zoomFactor: 1.5,
      deviceScaleFactor: 2,
      scroll: { x: 0, y: 40, extra: true },
      stability: "unstable",
      masks: [{ source: "sensitive-field", rect: { x: 1, y: 2, width: 3, height: 4 } }],
    });
    expect(result).toEqual({
      ok: true,
      value: {
        zoomFactor: 1.5,
        deviceScaleFactor: 2,
        scroll: { x: 0, y: 40 },
        stability: "unstable",
        masks: [{ source: "sensitive-field", rect: { x: 1, y: 2, width: 3, height: 4 } }],
      },
    });
    expect(validateWebAnnotationResultCaptureMetadata({})).toEqual({ ok: true, value: {} });
  });

  test("rejects out-of-range or malformed metadata", () => {
    for (const bad of [
      { zoomFactor: 0 },
      { deviceScaleFactor: 100 },
      { scroll: { x: "0", y: 0 } },
      { stability: "settled" },
      { masks: [{ x: 0, y: 0, width: 1, height: 1 }] },
      { masks: [{ source: "page", rect: { x: 0, y: 0, width: 1, height: 1 } }] },
      {
        masks: Array.from({ length: WEB_ANNOTATION_LIMITS.redactionRegions + 1 }, () => ({
          source: "manual",
          rect: { x: 0, y: 0, width: 1, height: 1 },
        })),
      },
      { targetResolution: { state: "found", rule: "none" } },
    ]) {
      expect(validateWebAnnotationResultCaptureMetadata(bad).ok).toBe(false);
    }
  });
});

describe("web annotation queue origin", () => {
  test("recognizes only well-formed annotation origins", () => {
    expect(
      webAnnotationQueueOrigin({
        id: "r1",
        origin: { kind: "web-annotation", requestId: "r1", bodyHash: "a".repeat(64) },
      }),
    ).toEqual({ kind: "web-annotation", requestId: "r1", bodyHash: "a".repeat(64) });
    expect(webAnnotationQueueOrigin({ id: "u1", text: "mine" })).toBeNull();
    expect(webAnnotationQueueOrigin({ origin: { kind: "mail", requestId: "r1" } })).toBeNull();
    expect(webAnnotationQueueOrigin(null)).toBeNull();
  });
});

describe("page identity sanitization", () => {
  test("removes credentials and token-like parameters and flags navigation", () => {
    const result = sanitizeWebAnnotationUrl(
      "http://user:pw@localhost:3000/app?tab=billing&access_token=abc#/x?code=123&view=grid",
    );
    expect(result.route).toBe("/app?tab=billing#/x?view=grid");
    expect(result.displayUrl).toBe("http://localhost:3000/app?tab=billing#/x?view=grid");
    expect(result.requiresNavigation).toBe(true);
    expect(result.removedParameters).toBe(3);
  });

  test("keeps meaningful state and strips gateway prefixes", () => {
    const result = sanitizeWebAnnotationUrl(
      "http://127.0.0.1:9000/__orkestrator/browser/loopback/5173/pricing?plan=pro#annual",
      { routePrefix: /^\/__orkestrator\/browser\/loopback\/\d+(\/.*)?$/ },
    );
    expect(result.route).toBe("/pricing?plan=pro#annual");
    expect(result.requiresNavigation).toBe(false);
  });

  test("opaque values are removed even under innocuous names", () => {
    const result = sanitizeWebAnnotationUrl(`http://localhost/x?ref=${"A".repeat(40)}`);
    expect(result.route).toBe("/x");
  });

  test("page keys ignore fragments but keep service identity", () => {
    expect(
      webAnnotationPageKey({ service: { kind: "service", serviceId: "web" }, route: "/a?b=1#c" }),
    ).toBe("service:web/a?b=1");
  });
});
