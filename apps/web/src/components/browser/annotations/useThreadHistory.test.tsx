import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  fixtureAnnotation,
  fixtureEntry,
} from "@orkestrator/protocol/testing/web-annotations-fixtures";
import type {
  WebAnnotationEntriesResult,
  WebAnnotationGetResult,
} from "@orkestrator/protocol/web-annotations";
import { invoke } from "@/lib/native/backend";
import { useThreadHistory } from "./useThreadHistory";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

function deferredPage() {
  let resolve!: (page: WebAnnotationEntriesResult) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<WebAnnotationEntriesResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function snapshot(annotationId = "note-a", environmentId = "env-a"): WebAnnotationGetResult {
  return {
    generation: "gen-1",
    revision: 1,
    annotation: fixtureAnnotation({ id: annotationId, environmentId }),
    capture: null,
    entries: [fixtureEntry({ id: `${environmentId}-${annotationId}`, annotationId, sequence: 10 })],
    previousEntrySequence: 10,
    nextEntrySequence: 11,
    requests: [],
    results: [],
  };
}

const stalePage: WebAnnotationEntriesResult = {
  entries: [fixtureEntry({ id: "stale-entry", sequence: 1 })],
  previousSequence: null,
  nextSequence: null,
  resetRequired: false,
};

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

describe("useThreadHistory request ownership", () => {
  for (const change of ["note", "environment", "away-and-back"] as const) {
    for (const outcome of ["success", "error", "reset"] as const) {
      test(`ignores stale ${outcome} after ${change} changes without remounting`, async () => {
        const old = deferredPage();
        const current = deferredPage();
        invokeMock.mockImplementationOnce(() => old.promise);
        invokeMock.mockImplementationOnce(() => current.promise);
        const initialProps = { environmentId: "env-a", data: snapshot() };
        const { result, rerender } = renderHook(
          ({ environmentId, data }) => useThreadHistory(environmentId, data),
          { initialProps },
        );
        let oldRequest!: Promise<void>;
        act(() => {
          oldRequest = result.current.loadOlder();
        });
        expect(result.current.loading).toBe(true);

        const next =
          change === "environment"
            ? { environmentId: "env-b", data: snapshot("note-a", "env-b") }
            : { environmentId: "env-a", data: snapshot("note-b") };
        rerender(next);
        if (change === "away-and-back") rerender(initialProps);
        expect(result.current.loading).toBe(false);
        expect(result.current.error).toBeNull();
        const expectedEntries = result.current.entries;
        let currentRequest!: Promise<void>;
        act(() => {
          currentRequest = result.current.loadNewer();
        });
        expect(result.current.loading).toBe(true);

        await act(async () => {
          if (outcome === "error") old.reject(new Error("old request failed"));
          else old.resolve({ ...stalePage, resetRequired: outcome === "reset" });
          await oldRequest;
        });
        expect(result.current.entries).toEqual(expectedEntries);
        expect(result.current.error).toBeNull();
        expect(result.current.loading).toBe(true);
        expect(result.current.hasOlder).toBe(true);
        expect(result.current.hasNewer).toBe(true);

        await act(async () => {
          current.resolve({
            ...stalePage,
            entries: [fixtureEntry({ id: "current-entry", sequence: 11 })],
          });
          await currentRequest;
        });
        expect(result.current.loading).toBe(false);
        expect(result.current.entries.map((entry) => entry.id)).toEqual([
          expectedEntries[0]!.id,
          "current-entry",
        ]);
        expect(result.current.hasNewer).toBe(false);
      });
    }
  }

  test("clears errors and both cursors when the note becomes unavailable", async () => {
    invokeMock.mockRejectedValueOnce(new Error("page failed"));
    const { result, rerender } = renderHook(
      ({ data }: { data: WebAnnotationGetResult | null }) => useThreadHistory("env-a", data),
      { initialProps: { data: snapshot() as WebAnnotationGetResult | null } },
    );
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.error).toContain("page failed");
    rerender({ data: null });
    expect(result.current.entries).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.hasOlder).toBe(false);
    expect(result.current.hasNewer).toBe(false);
  });

  test("uses the next note's cursors after paging the previous note", async () => {
    invokeMock.mockResolvedValueOnce(stalePage);
    const { result, rerender } = renderHook(({ data }) => useThreadHistory("env-a", data), {
      initialProps: { data: snapshot() },
    });
    await act(async () => {
      await result.current.loadOlder();
    });
    expect(result.current.hasOlder).toBe(false);
    rerender({ data: snapshot("note-b") });
    expect(result.current.hasOlder).toBe(true);
    expect(result.current.entries.map((entry) => entry.id)).toEqual(["env-a-note-b"]);
  });
});
