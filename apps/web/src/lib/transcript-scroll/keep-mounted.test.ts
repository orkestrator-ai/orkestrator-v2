import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { keepMountedOverscan, ratchetOverscan, useRatchetedOverscan } from "./keep-mounted";

afterEach(cleanup);

describe("ratchetOverscan", () => {
  test("grows on each side but never shrinks", () => {
    expect(ratchetOverscan({ top: 10, bottom: 2 }, { top: 2, bottom: 4 })).toEqual({
      top: 10,
      bottom: 4,
    });
    expect(ratchetOverscan({ top: 2, bottom: 2 }, { top: 6, bottom: 2 })).toEqual({
      top: 6,
      bottom: 2,
    });
  });

  test("a release or a first protection takes the new value as it is", () => {
    expect(ratchetOverscan({ top: 10, bottom: 2 }, null)).toBeNull();
    const next = { top: 3, bottom: 2 };
    expect(ratchetOverscan(null, next)).toBe(next);
  });
});

describe("useRatchetedOverscan", () => {
  test("settles the range feedback loop a re-rendering list produces", () => {
    // The ranges a real list reported while protecting row 85, each one
    // measured during the re-render the previous overscan caused. Without the
    // ratchet the overscan cycled 10 → 2 → 4 → 10 for ever.
    const ranges = [
      { startIndex: 93, endIndex: 99 },
      { startIndex: 73, endIndex: 97 },
      { startIndex: 87, endIndex: 97 },
    ];
    const { result, rerender } = renderHook(
      ({ range }) => useRatchetedOverscan("row-85", keepMountedOverscan(85, range)),
      { initialProps: { range: ranges[0]! } },
    );
    const applied = [result.current];
    for (const range of [...ranges, ...ranges]) {
      rerender({ range });
      applied.push(result.current);
    }
    expect(new Set(applied.map((overscan) => overscan?.top))).toEqual(new Set([10]));
  });

  test("a new protected row starts from what it needs", () => {
    const { result, rerender } = renderHook(
      ({ key, overscan }) => useRatchetedOverscan(key, overscan),
      { initialProps: { key: "a", overscan: { top: 10, bottom: 2 } } },
    );
    rerender({ key: "b", overscan: { top: 2, bottom: 2 } });
    expect(result.current).toEqual({ top: 2, bottom: 2 });
  });

  test("protection beyond the bound still releases", () => {
    const { result, rerender } = renderHook(
      ({ range }) => useRatchetedOverscan("row-1", keepMountedOverscan(1, range)),
      { initialProps: { range: { startIndex: 4, endIndex: 9 } } },
    );
    expect(result.current).not.toBeNull();
    rerender({ range: { startIndex: 40, endIndex: 45 } });
    expect(result.current).toBeNull();
  });
});
