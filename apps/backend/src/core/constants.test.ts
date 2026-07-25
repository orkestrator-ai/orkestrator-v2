import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
  MAX_CODEX_CONCURRENT_THREADS,
  resolveCodexMaxConcurrentThreads,
} from "./constants.js";

describe("resolveCodexMaxConcurrentThreads", () => {
  test.each([
    ["missing", undefined],
    ["numeric string", "8"],
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["NaN", Number.NaN],
    ["infinity", Number.POSITIVE_INFINITY],
    ["root-slot overflow", Number.MAX_SAFE_INTEGER],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("falls back for %s values", (_label, value) => {
    expect(resolveCodexMaxConcurrentThreads(value)).toBe(
      DEFAULT_CODEX_MAX_CONCURRENT_THREADS,
    );
  });

  test.each([
    ["minimum", 1],
    ["maximum child limit", MAX_CODEX_CONCURRENT_THREADS],
  ])("preserves the %s valid value", (_label, value) => {
    expect(resolveCodexMaxConcurrentThreads(value)).toBe(value);
  });
});
