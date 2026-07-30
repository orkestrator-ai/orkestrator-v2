import { describe, expect, test } from "bun:test";
import {
  isResourceChange,
  isResourceKind,
  RESOURCE_CHANGED_EVENT,
  RESOURCE_KINDS,
  type ResourceChange,
} from "./resource-events";

/**
 * These validators sit on a network trust boundary: the gateway serves the web
 * client to arbitrary browsers, so a frame reaching `isResourceChange` has not
 * necessarily been produced by this backend. Everything it accepts triggers a
 * refetch, so the rejection cases matter more than the acceptance one.
 */

function change(overrides: Partial<ResourceChange> = {}): unknown {
  return { resource: "environment", id: "env-1", revision: 1, ...overrides };
}

describe("isResourceKind", () => {
  test("accepts every declared kind", () => {
    for (const kind of RESOURCE_KINDS) {
      expect(isResourceKind(kind)).toBe(true);
    }
  });

  test("rejects an undeclared kind", () => {
    expect(isResourceKind("environments")).toBe(false);
    expect(isResourceKind("")).toBe(false);
  });

  test("rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, [], true]) {
      expect(isResourceKind(value)).toBe(false);
    }
  });

  test("declares no duplicate kinds", () => {
    expect(new Set(RESOURCE_KINDS).size).toBe(RESOURCE_KINDS.length);
  });
});

describe("isResourceChange", () => {
  test("accepts a well-formed change", () => {
    expect(isResourceChange(change())).toBe(true);
  });

  test("accepts a well-formed project-attributed change", () => {
    expect(isResourceChange(change({ projectId: "project-1" }))).toBe(true);
  });

  test("accepts a change carrying extra fields", () => {
    expect(isResourceChange({ ...(change() as object), extra: "ignored" })).toBe(true);
  });

  test("rejects non-objects", () => {
    for (const value of [null, undefined, "environment", 7, true]) {
      expect(isResourceChange(value)).toBe(false);
    }
  });

  test("rejects an unknown resource kind", () => {
    expect(isResourceChange(change({ resource: "secrets" as never }))).toBe(false);
  });

  test("rejects a missing or blank id", () => {
    expect(isResourceChange(change({ id: "" }))).toBe(false);
    expect(isResourceChange({ resource: "environment", revision: 1 })).toBe(false);
  });

  test("rejects a non-string id", () => {
    expect(isResourceChange(change({ id: 42 as never }))).toBe(false);
  });

  test("rejects a blank or non-string project id", () => {
    for (const projectId of ["", "   ", 42, null, {}, []]) {
      expect(isResourceChange(change({ projectId: projectId as never }))).toBe(false);
    }
  });

  test("rejects a non-finite revision", () => {
    // NaN and Infinity are `typeof "number"`, so the finiteness check is the
    // only thing standing between them and the coalescing comparison.
    expect(isResourceChange(change({ revision: Number.NaN }))).toBe(false);
    expect(isResourceChange(change({ revision: Number.POSITIVE_INFINITY }))).toBe(false);
  });

  test("rejects a revision that cannot be part of the positive integer sequence", () => {
    for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(isResourceChange(change({ revision }))).toBe(false);
    }
  });

  test("rejects a non-number revision", () => {
    expect(isResourceChange(change({ revision: "1" as never }))).toBe(false);
    expect(isResourceChange({ resource: "environment", id: "env-1" })).toBe(false);
  });
});

describe("RESOURCE_CHANGED_EVENT", () => {
  test("is a stable non-empty event name", () => {
    // Backend emit and client listen are wired by this literal in separate
    // packages, so a rename has to be deliberate.
    expect(RESOURCE_CHANGED_EVENT).toBe("resource-changed");
  });
});
