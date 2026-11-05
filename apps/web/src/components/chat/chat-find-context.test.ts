import { expect, test } from "bun:test";
import {
  activeDocumentOccurrence,
  recordStaticFindMatch,
  staticDocumentMatchRect,
} from "./chat-find-context";

test("document ordinals exclude preceding prose, summary and other rows", () => {
  const roots = [
    { key: "0:text", start: 0, end: 10 },
    { key: "1:summary", start: 11, end: 20 },
    { key: "1:body", start: 21, end: 60, publicationId: "pub" },
  ];
  const match = (itemIndex: number, characterIndex: number) => ({
    itemIndex,
    characterIndex,
    occurrenceIndex: 0,
  });
  const matches = [match(0, 1), match(0, 12), match(1, 22), match(0, 23), match(0, 40)];
  expect(activeDocumentOccurrence(roots, matches, matches[4]!)).toEqual({
    publicationId: "pub",
    occurrence: 1,
  });
  expect(activeDocumentOccurrence(roots, matches, matches[3]!)).toEqual({
    publicationId: "pub",
    occurrence: 0,
  });
  expect(activeDocumentOccurrence(roots, matches, matches[1]!)).toBeNull();
});

test("frame geometry scales CSS pixels and border offsets into the host viewport", () => {
  const card = document.createElement("div");
  card.innerHTML = "<div data-artifact-search-body><span></span></div><iframe></iframe>";
  const iframe = card.querySelector("iframe")!;
  const mirror = card.querySelector("span")!;
  Object.defineProperty(iframe, "offsetHeight", { value: 604 });
  Object.defineProperty(iframe, "clientTop", { value: 2 });
  iframe.getBoundingClientRect = () => new DOMRect(10, 100, 750, 906);
  recordStaticFindMatch(iframe, { top: 600, height: 16 });
  const box = staticDocumentMatchRect(mirror)!;
  expect([box.top, box.height]).toEqual([1003, 24]);
  recordStaticFindMatch(iframe, null);
  expect(staticDocumentMatchRect(mirror)).toBeNull();
});
