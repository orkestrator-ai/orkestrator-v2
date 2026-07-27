import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { useEscapeToStop } from "./useEscapeToStop";

function Harness({
  isActive = true,
  isLoading = true,
  onStop,
}: {
  isActive?: boolean;
  isLoading?: boolean;
  onStop: () => void;
}) {
  useEscapeToStop({ isActive, isLoading, onStop });
  return null;
}

function pressEscape(init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(window, { key: "Escape", ...init });
}

afterEach(() => cleanup());

describe("useEscapeToStop", () => {
  test("stops the turn on a plain Escape", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape();
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  test("only the visible tab claims the key", () => {
    // Several tabs are mounted at once; a background one must not swallow
    // Escape and interrupt a turn the user cannot even see.
    const onStop = mock(() => {});
    render(<Harness isActive={false} onStop={onStop} />);

    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  test("does not bind when there is no turn to interrupt", () => {
    const onStop = mock(() => {});
    render(<Harness isLoading={false} onStop={onStop} />);

    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores a key another handler already consumed", () => {
    // A dialog or the slash-command menu closing on Escape must not also stop
    // the turn behind it.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores auto-repeat so holding Escape stops once", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ repeat: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores modified Escape presses", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ metaKey: true });
    pressEscape({ ctrlKey: true });
    pressEscape({ altKey: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores Escape while an IME composition is active", () => {
    // There Escape cancels the composition; treating it as a stop would abort
    // the turn out from under someone mid-word.
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    pressEscape({ isComposing: true });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("ignores other keys", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    fireEvent.keyDown(window, { key: "Enter" });
    expect(onStop).not.toHaveBeenCalled();
  });

  test("marks the event handled so nothing else acts on it", () => {
    const onStop = mock(() => {});
    render(<Harness onStop={onStop} />);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });

  test("unbinds on unmount", () => {
    const onStop = mock(() => {});
    const { unmount } = render(<Harness onStop={onStop} />);

    unmount();
    pressEscape();
    expect(onStop).not.toHaveBeenCalled();
  });
});
