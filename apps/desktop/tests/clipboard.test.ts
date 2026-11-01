import { describe, expect, mock, test } from "bun:test";
import { createClipboardTextWriter } from "../electron/clipboard";

describe("createClipboardTextWriter", () => {
  test("writes the text and returns synchronously", async () => {
    const writeText = mock(async (_text: string) => undefined);
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    expect(write("copied")).toBeUndefined();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("copied");
    expect(logError).not.toHaveBeenCalled();
  });

  test("observes a rejected write instead of leaving it unhandled", async () => {
    const failure = new Error("clipboard unavailable");
    const writeText = mock(async (_text: string) => {
      throw failure;
    });
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    write("copied");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(logError).toHaveBeenCalledWith(failure);
  });

  test("logs a synchronous throw from the clipboard module", () => {
    const failure = new Error("not ready");
    const writeText = mock((_text: string): Promise<void> => {
      throw failure;
    });
    const logError = mock((_error: unknown) => undefined);
    const write = createClipboardTextWriter({ writeText }, logError);

    expect(() => write("copied")).not.toThrow();
    expect(logError).toHaveBeenCalledWith(failure);
  });
});
