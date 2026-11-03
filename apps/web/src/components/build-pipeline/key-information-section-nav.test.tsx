import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useKeepActiveEntryInView } from "./key-information-section-nav";

afterEach(cleanup);

for (const [label, box, expected] of [
  ["right", { left: 180, right: 240, top: 20, bottom: 50 }, { left: 40, top: 0 }],
  ["left", { left: -30, right: 40, top: 20, bottom: 50 }, { left: -30, top: 0 }],
  ["below", { left: 20, right: 80, top: 180, bottom: 230 }, { left: 0, top: 30 }],
  ["above", { left: 20, right: 80, top: -20, bottom: 40 }, { left: 0, top: -20 }],
] as const) {
  test(`reveals an active entry ${label} by scrolling only its navigation list`, () => {
    const ancestor = document.createElement("div");
    const list = document.createElement("nav");
    const entry = document.createElement("button");
    ancestor.append(list);
    list.append(entry);
    list.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 200 }) as DOMRect;
    entry.getBoundingClientRect = () => box as DOMRect;
    const scrollBy = mock(() => undefined);
    list.scrollBy = scrollBy;
    const outerScroll = mock(() => undefined);
    ancestor.scrollBy = outerScroll;
    const scrollIntoView = mock(() => undefined);
    entry.scrollIntoView = scrollIntoView;
    const { rerender } = renderHook(
      ({ active }) => useKeepActiveEntryInView({ current: list }, active),
      {
        initialProps: { active: "first" },
      },
    );
    expect(scrollBy).not.toHaveBeenCalled();
    entry.setAttribute("aria-current", "location");
    rerender({ active: "second" });
    expect(scrollBy).toHaveBeenCalledWith(expected);
    expect(outerScroll).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
}

test("leaves a fully visible active entry and its ancestors still", () => {
  const list = document.createElement("nav");
  const entry = document.createElement("button");
  list.append(entry);
  entry.setAttribute("aria-current", "location");
  list.getBoundingClientRect = () => ({ left: 0, right: 200, top: 0, bottom: 200 }) as DOMRect;
  entry.getBoundingClientRect = () => ({ left: 10, right: 100, top: 10, bottom: 50 }) as DOMRect;
  const scrollBy = mock(() => undefined);
  list.scrollBy = scrollBy;
  renderHook(() => useKeepActiveEntryInView({ current: list }, "visible"));
  expect(scrollBy).not.toHaveBeenCalled();
});
