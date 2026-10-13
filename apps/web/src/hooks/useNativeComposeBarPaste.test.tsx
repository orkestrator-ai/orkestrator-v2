import { useRef } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { useNativeComposeBarPaste } from "./useNativeComposeBarPaste";

function imagePasteEvent(): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  const image = new File(["png"], "shot.png", { type: "image/png" });
  Object.defineProperty(event, "clipboardData", {
    value: { items: [], files: [image], getData: () => "" },
  });
  return event;
}

function Composer({
  locked,
  beginPaste,
  onAttach,
}: {
  locked: "readOnly" | "ariaDisabled" | null;
  beginPaste: (hasImage: boolean) => false;
  onAttach: () => void;
}) {
  const inputContainerRef = useRef<HTMLDivElement>(null);
  useNativeComposeBarPaste({
    inputContainerRef,
    beginPaste,
    containerId: null,
    worktreePath: "/tmp/worktree",
    onAttach,
    logLabel: "test",
  });
  return (
    <div ref={inputContainerRef}>
      {locked === "ariaDisabled" ? (
        <div data-testid="input" tabIndex={-1} aria-disabled="true" />
      ) : (
        <textarea data-testid="input" readOnly={locked === "readOnly"} />
      )}
    </div>
  );
}

describe("useNativeComposeBarPaste", () => {
  afterEach(() => cleanup());

  test("claims image pastes while the composer accepts input", () => {
    const beginPaste = mock((_hasImage: boolean) => false as const);
    const onAttach = mock(() => {});
    const { getByTestId } = render(
      <Composer locked={null} beginPaste={beginPaste} onAttach={onAttach} />,
    );
    getByTestId("input").focus();

    const event = imagePasteEvent();
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(beginPaste).toHaveBeenCalledWith(true);
  });

  for (const locked of ["readOnly", "ariaDisabled"] as const) {
    test(`ignores pastes into a focused composer locked by an in-flight send (${locked})`, () => {
      const beginPaste = mock((_hasImage: boolean) => false as const);
      const onAttach = mock(() => {});
      const { getByTestId } = render(
        <Composer locked={locked} beginPaste={beginPaste} onAttach={onAttach} />,
      );
      getByTestId("input").focus();

      const event = imagePasteEvent();
      document.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(beginPaste).not.toHaveBeenCalled();
      expect(onAttach).not.toHaveBeenCalled();
    });
  }
});
