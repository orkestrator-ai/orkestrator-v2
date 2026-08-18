import { describe, expect, mock, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import { MobileTerminalKeyBar, resolveTerminalKeyData } from "./MobileTerminalKeyBar";

describe("resolveTerminalKeyData", () => {
  test("converts only complete CSI arrow sequences in application cursor mode", () => {
    expect(resolveTerminalKeyData("\u001b[A", true)).toBe("\u001bOA");
    expect(resolveTerminalKeyData("\u001b[B", true)).toBe("\u001bOB");
    expect(resolveTerminalKeyData("\u001b[C", true)).toBe("\u001bOC");
    expect(resolveTerminalKeyData("\u001b[D", true)).toBe("\u001bOD");

    for (const data of [
      "\u001b",
      "\t",
      "\u0003",
      "\u001b[",
      "\u001b[1",
      "\u001b[3~",
      "\u001b[AA",
      "plain text",
    ]) {
      expect(resolveTerminalKeyData(data, true)).toBe(data);
    }
  });

  test("leaves arrows unchanged outside application cursor mode", () => {
    expect(resolveTerminalKeyData("\u001b[A", false)).toBe("\u001b[A");
  });
});

describe("MobileTerminalKeyBar", () => {
  test("renders labelled controls and forwards each terminal sequence", () => {
    const onInput = mock((_data: string) => {});
    render(<MobileTerminalKeyBar onInput={onInput} />);

    const expected = [
      ["Escape", "\u001b"],
      ["Tab", "\t"],
      ["Control C", "\u0003"],
      ["Up arrow", "\u001b[A"],
      ["Down arrow", "\u001b[B"],
      ["Left arrow", "\u001b[D"],
      ["Right arrow", "\u001b[C"],
    ] as const;

    for (const [name] of expected) {
      fireEvent.click(screen.getByRole("button", { name }));
    }

    expect(onInput.mock.calls.map(([data]) => data)).toEqual(expected.map(([, data]) => data));
  });

  test("disables every control without forwarding input", () => {
    const onInput = mock((_data: string) => {});
    render(<MobileTerminalKeyBar onInput={onInput} disabled />);

    for (const button of screen.getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onInput).not.toHaveBeenCalled();
  });

  test("supports contained positioning and caller classes", () => {
    render(<MobileTerminalKeyBar onInput={() => {}} contained className="test-position" />);

    const container = screen.getByRole("toolbar", { name: "Terminal keys" }).parentElement;
    expect(container?.className).toContain("relative");
    expect(container?.className).toContain("shrink-0");
    expect(container?.className).toContain("test-position");
    expect(container?.className).not.toContain("absolute");
  });

  test("prevents pointer focus changes before dispatching the click", () => {
    const onInput = mock((_data: string) => {});
    render(
      <>
        <input aria-label="terminal input" />
        <MobileTerminalKeyBar onInput={onInput} />
      </>,
    );
    const terminalInput = screen.getByRole("textbox", { name: "terminal input" });
    terminalInput.focus();
    const escape = screen.getByRole("button", { name: "Escape" });
    const event = new PointerEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
    });

    escape.dispatchEvent(event);
    fireEvent.click(escape);

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(terminalInput);
    expect(onInput).toHaveBeenCalledWith("\u001b");
  });
});
