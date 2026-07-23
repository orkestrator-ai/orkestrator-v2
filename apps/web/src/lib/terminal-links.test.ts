import { describe, expect, test } from "bun:test";
import { getTerminalLinkTarget } from "./terminal-links";

describe("getTerminalLinkTarget", () => {
  test("keeps unmodified clicks inside the terminal", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe("none");
  });

  test("opens Cmd+Click and Ctrl+Click externally", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: true,
        shiftKey: false,
      }),
    ).toBe("external");
    expect(
      getTerminalLinkTarget({
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
      }),
    ).toBe("external");
  });

  test("opens shifted modifier clicks in an Orkestrator browser tab", () => {
    expect(
      getTerminalLinkTarget({
        ctrlKey: false,
        metaKey: true,
        shiftKey: true,
      }),
    ).toBe("browser-tab");
    expect(
      getTerminalLinkTarget({
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe("browser-tab");
  });
});
