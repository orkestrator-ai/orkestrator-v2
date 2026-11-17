import { expect, test } from "bun:test";
import { createXtermTerminal } from "@/lib/terminal-xterm";
import { bindOsc52ClipboardGestures } from "@/lib/terminal-osc52";
import { mockWriteText } from "../mocks/clipboard";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";

test("terminal constructor installs OSC 52 and declares clipboard failures", async () => {
  const logs = captureLogs();
  const { terminal } = createXtermTerminal({}, undefined, {
    environmentId: "osc-env",
    tabId: "osc-tab",
  });
  let gesture: ((event: Event) => void) | undefined;
  const host = {
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === "keydown") gesture = listener;
    },
    removeEventListener() {},
  } as unknown as HTMLElement;
  bindOsc52ClipboardGestures(terminal, host);
  mockWriteText.mockReset();
  mockWriteText.mockImplementation(async () => {
    throw new Error("clipboard unavailable");
  });
  try {
    gesture?.({ isTrusted: true } as Event);
    await new Promise<void>((resolve) => terminal.write("\x1b]52;c;Y29waWVk\x07", resolve));
    expect(mockWriteText).toHaveBeenCalledWith("copied");
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ area: "terminal", event: "clipboard.osc52-copy-failed" }),
    );
  } finally {
    terminal.dispose();
    logs.restore();
    mockWriteText.mockReset();
    mockWriteText.mockImplementation(async () => {});
  }
});
