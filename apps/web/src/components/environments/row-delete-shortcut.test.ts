import { afterEach, describe, expect, mock, test } from "bun:test";
import { armRowDeleteShortcut, isDeleteRowChord } from "./row-delete-shortcut";

const chord = { key: "Backspace", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

function press(init: KeyboardEventInit, target: EventTarget = window): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

let disarms: Array<() => void> = [];
function arm(onDelete: () => void): () => void {
  const disarm = armRowDeleteShortcut(onDelete);
  disarms.push(disarm);
  return disarm;
}

afterEach(() => {
  for (const disarm of disarms) disarm();
  disarms = [];
  document.body.innerHTML = "";
});

describe("isDeleteRowChord", () => {
  test("Backspace or Delete with ⌘ or Ctrl, and no other modifier", () => {
    expect(isDeleteRowChord({ ...chord, metaKey: true })).toBe(true);
    expect(isDeleteRowChord({ ...chord, ctrlKey: true })).toBe(true);
    expect(isDeleteRowChord({ ...chord, key: "Delete", metaKey: true })).toBe(true);
    expect(isDeleteRowChord(chord)).toBe(false);
    expect(isDeleteRowChord({ ...chord, metaKey: true, shiftKey: true })).toBe(false);
    expect(isDeleteRowChord({ ...chord, ctrlKey: true, altKey: true })).toBe(false);
    expect(isDeleteRowChord({ ...chord, key: "a", metaKey: true })).toBe(false);
  });
});

describe("armRowDeleteShortcut", () => {
  test("the chord after the click asks once, and never reaches the focused field", () => {
    const onDelete = mock(() => undefined);
    const field = document.createElement("textarea");
    const fieldKeys = mock(() => undefined);
    field.addEventListener("keydown", fieldKeys);
    document.body.append(field);
    arm(onDelete);

    press({ key: "Meta", metaKey: true }, field);
    const event = press({ key: "Backspace", metaKey: true }, field);

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    // Only the modifier reached the field.
    expect(fieldKeys).toHaveBeenCalledTimes(1);

    press({ key: "Backspace", metaKey: true }, field);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  test("any other key, a pointer press or leaving the window disarms it", () => {
    for (const interrupt of [
      () => press({ key: "a" }),
      () => press({ key: "Backspace" }),
      () => press({ key: "Backspace", metaKey: true, repeat: true }),
      () => window.dispatchEvent(new PointerEvent("pointerdown")),
      () => window.dispatchEvent(new FocusEvent("blur")),
    ]) {
      const onDelete = mock(() => undefined);
      arm(onDelete);
      interrupt();
      const event = press({ key: "Backspace", ctrlKey: true });
      expect(onDelete).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    }
  });

  test("arming another row disarms the first, and disarm stops it", () => {
    const first = mock(() => undefined);
    const second = mock(() => undefined);
    arm(first);
    const disarmSecond = arm(second);
    press({ key: "Backspace", metaKey: true });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    const third = mock(() => undefined);
    arm(third)();
    disarmSecond();
    press({ key: "Backspace", metaKey: true });
    expect(third).not.toHaveBeenCalled();
  });
});
