import { describe, expect, mock, test } from "bun:test";
import { Terminal } from "@xterm/xterm";
import {
  bindOsc52ClipboardGestures,
  suppressOsc52Clipboard,
  decodeOsc52Write,
  installOsc52ClipboardHandler,
  MAX_OSC_52_BASE64_LENGTH,
  OSC_52,
  OSC_52_INPUT_WINDOW_MS,
} from "./terminal-osc52";

function base64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fakeTerminal() {
  let oscHandler: ((data: string) => boolean | Promise<boolean>) | null = null;
  const gestures = new Map<string, (event: Event) => void>();
  const disposed: string[] = [];
  const terminal = {
    parser: {
      registerOscHandler: mock((ident: number, handler: (data: string) => boolean) => {
        expect(ident).toBe(OSC_52);
        oscHandler = handler;
        return { dispose: () => disposed.push("osc") };
      }),
    },
    loadAddon: () => {},
  };
  return {
    terminal: terminal as unknown as Pick<Terminal, "parser" | "loadAddon">,
    sendOsc: (data: string) => oscHandler?.(data),
    host: {
      addEventListener: (type: string, listener: (event: Event) => void) =>
        gestures.set(type, listener),
      removeEventListener: (type: string) => {
        gestures.delete(type);
      },
    } as unknown as HTMLElement,
    input: (isTrusted = true) => gestures.get("keydown")?.({ isTrusted } as Event),
    binaryInput: () => gestures.get("pointerup")?.({ isTrusted: true } as Event),
    disposed,
  };
}

describe("decodeOsc52Write", () => {
  test("decodes UTF-8 text for any selection target", () => {
    expect(decodeOsc52Write(`c;${base64("vpnkit is installed — ok")}`)).toBe(
      "vpnkit is installed — ok",
    );
    expect(decodeOsc52Write(`;${base64("empty target")}`)).toBe("empty target");
    expect(decodeOsc52Write(`p;${base64("primary")}`)).toBe("primary");
  });

  test("tolerates whitespace a sender wraps into the base64", () => {
    const encoded = base64("a long line that wraps");
    expect(decodeOsc52Write(`c;${encoded.slice(0, 8)}\n${encoded.slice(8)}`)).toBe(
      "a long line that wraps",
    );
  });

  test("refuses queries, clears and malformed or oversized payloads", () => {
    expect(decodeOsc52Write("c;?")).toBeNull();
    expect(decodeOsc52Write("c;")).toBeNull();
    expect(decodeOsc52Write("no-separator")).toBeNull();
    expect(decodeOsc52Write("c;not base64!")).toBeNull();
    expect(decodeOsc52Write("c;abcde")).toBeNull();
    expect(decodeOsc52Write(`c;${"A".repeat(MAX_OSC_52_BASE64_LENGTH + 4)}`)).toBeNull();
  });
});

describe("installOsc52ClipboardHandler", () => {
  test("copies a write that follows input in the terminal", async () => {
    let now = 1_000;
    const writeText = mock(async (_text: string) => {});
    const fake = fakeTerminal();
    installOsc52ClipboardHandler(fake.terminal, { writeText, now: () => now });

    bindOsc52ClipboardGestures(fake.terminal, fake.host);
    fake.input();
    now += OSC_52_INPUT_WINDOW_MS;
    expect(fake.sendOsc(`c;${base64("copied")}`)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("copied");

    fake.binaryInput();
    now += 10;
    fake.sendOsc(`c;${base64("after mouse")}`);
    expect(writeText).toHaveBeenLastCalledWith("after mouse");
  });

  test("ignores writes with no recent input, such as replayed output", () => {
    let now = 1_000;
    const writeText = mock(async (_text: string) => {});
    const fake = fakeTerminal();
    installOsc52ClipboardHandler(fake.terminal, { writeText, now: () => now });

    expect(fake.sendOsc(`c;${base64("replayed")}`)).toBe(true);
    bindOsc52ClipboardGestures(fake.terminal, fake.host);
    fake.input();
    now += OSC_52_INPUT_WINDOW_MS + 1;
    fake.sendOsc(`c;${base64("background")}`);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("never answers a read request", () => {
    const writeText = mock(async (_text: string) => {});
    const fake = fakeTerminal();
    installOsc52ClipboardHandler(fake.terminal, { writeText, now: () => 0 });
    bindOsc52ClipboardGestures(fake.terminal, fake.host);
    fake.input();
    expect(fake.sendOsc("c;?")).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
  });

  test("reports a failed clipboard write instead of rejecting", async () => {
    const failure = new Error("clipboard unavailable");
    const onError = mock((_error: unknown) => {});
    const fake = fakeTerminal();
    installOsc52ClipboardHandler(fake.terminal, {
      writeText: async () => {
        throw failure;
      },
      onError,
      now: () => 0,
    });
    bindOsc52ClipboardGestures(fake.terminal, fake.host);
    fake.input();
    fake.sendOsc(`c;${base64("x")}`);
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  test("dispose removes every listener", () => {
    const fake = fakeTerminal();
    const handle = installOsc52ClipboardHandler(fake.terminal, { writeText: async () => {} });
    handle.dispose();
    expect(fake.disposed).toEqual(["osc"]);
  });

  test("a real xterm terminal hands the sequence to the handler", async () => {
    const terminal = new Terminal({ allowProposedApi: false });
    const writeText = mock(async (_text: string) => {});
    installOsc52ClipboardHandler(terminal, { writeText, now: () => 0 });
    const fake = fakeTerminal();
    bindOsc52ClipboardGestures(terminal, fake.host);
    fake.input();
    await new Promise<void>((resolve) =>
      terminal.write(`\x1b]52;c;${base64("from claude")}\x07`, resolve),
    );
    expect(writeText).toHaveBeenCalledWith("from claude");
    terminal.dispose();
  });
  test("real xterm replies and synthetic input cannot authorize clipboard writes", async () => {
    const terminal = new Terminal();
    const fake = fakeTerminal();
    let now = 0;
    const writeText = mock(async (_text: string) => {});
    installOsc52ClipboardHandler(terminal, { writeText, now: () => now });
    bindOsc52ClipboardGestures(terminal, fake.host);
    const output = async (prefix: string) =>
      new Promise<void>((resolve) => terminal.write(`${prefix}\x1b]52;c;eA==\x07`, resolve));
    for (const query of ["\x1b[c", "\x1b[>c", "\x1b[5n", "\x1b[6n"]) {
      await output(query);
      terminal.input("synthetic");
      fake.input(false);
      await output(query);
      expect(writeText).not.toHaveBeenCalled();
      fake.input();
      now += OSC_52_INPUT_WINDOW_MS + 1;
      await output(query);
      expect(writeText).not.toHaveBeenCalled();
    }
    fake.binaryInput();
    await output("");
    expect(writeText).toHaveBeenCalledTimes(1);
    const release = suppressOsc52Clipboard(terminal);
    fake.input();
    await output("\x1b[5n");
    release();
    await output("");
    expect(writeText).toHaveBeenCalledTimes(1);
    terminal.dispose();
  });
});
