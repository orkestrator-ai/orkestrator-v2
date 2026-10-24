import { describe, expect, test } from "bun:test";
import type { WebAnnotationAnchorResolution } from "@orkestrator/protocol/web-annotations";
import { currentDocumentResults, newestGeneration } from "./useAnnotationPins";

function resolution(documentGeneration: number | null): WebAnnotationAnchorResolution {
  return { state: "matched", rule: "stable-id", candidateCount: 1, documentGeneration, rect: null };
}

describe("pin results by document generation", () => {
  test("results of an older document are dropped once a newer one is known", () => {
    const results = new Map([
      ["left-page", resolution(4)],
      ["current", resolution(5)],
      ["older-desktop", resolution(null)],
    ]);
    const current = currentDocumentResults(results, 5);
    expect(Array.from(current.keys())).toEqual(["current", "older-desktop"]);
  });

  test("nothing is dropped while the generation is unknown or every result is current", () => {
    const results = new Map([["a", resolution(2)]]);
    expect(currentDocumentResults(results, null)).toBe(results);
    expect(currentDocumentResults(results, 2)).toBe(results);
  });

  test("the newest generation is read from the results themselves", () => {
    expect(newestGeneration([resolution(3), resolution(null), resolution(7)])).toBe(7);
    expect(newestGeneration([resolution(null)])).toBeNull();
  });
});
