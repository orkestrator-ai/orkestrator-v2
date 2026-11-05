import { describe, expect, test } from "bun:test";
import {
  MAX_RENDERER_ERROR_BATCH,
  MAX_RENDERER_ERROR_COUNT,
  parseRendererErrorBatch,
  parseRendererErrorEntry,
  type RendererErrorEntry,
} from "./renderer-errors.js";

const entry: RendererErrorEntry = {
  errorClass: "TypeError",
  boundary: "lazy-view",
  route: "window",
  fingerprint: "deadbeef",
  count: 2,
};

describe("a renderer error entry", () => {
  test("parses exactly as sent", () => {
    expect(parseRendererErrorEntry(entry)).toEqual(entry);
  });

  test("is refused with a message, a stack or any other extra field", () => {
    expect(parseRendererErrorEntry({ ...entry, message: "secret" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, stack: "at x (/a/b.js:1:1)" })).toBeNull();
    const { count: _count, ...missing } = entry;
    expect(parseRendererErrorEntry(missing)).toBeNull();
  });

  test("is refused with a value outside its list", () => {
    expect(parseRendererErrorEntry({ ...entry, errorClass: "SecretError" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, boundary: "SettingsPage" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, route: "/projects/abc" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, fingerprint: "DEADBEEF" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, fingerprint: "deadbeef0" })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, count: 0 })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, count: 1.5 })).toBeNull();
    expect(parseRendererErrorEntry({ ...entry, count: "2" })).toBeNull();
  });

  test("caps a huge count", () => {
    expect(parseRendererErrorEntry({ ...entry, count: 2 ** 40 })?.count).toBe(
      MAX_RENDERER_ERROR_COUNT,
    );
  });
});

describe("a batch", () => {
  test("is a non-empty list of valid entries within the bound", () => {
    expect(parseRendererErrorBatch([entry])).toEqual([entry]);
    expect(parseRendererErrorBatch([])).toBeNull();
    expect(parseRendererErrorBatch({ entries: [entry] })).toBeNull();
    expect(
      parseRendererErrorBatch(Array.from({ length: MAX_RENDERER_ERROR_BATCH + 1 }, () => entry)),
    ).toBeNull();
  });

  test("one bad entry refuses the whole write", () => {
    expect(parseRendererErrorBatch([entry, { ...entry, message: "x" }])).toBeNull();
  });
});
