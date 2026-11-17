import type { IDisposable, Terminal } from "@xterm/xterm";

/**
 * OSC 52 ("manipulate selection data") lets a program in the terminal put
 * text on the clipboard. xterm.js parses the sequence but does nothing with
 * it, so without this handler a program that owns the mouse loses its copy:
 * Claude Code's fullscreen renderer turns mouse reporting on, selects text
 * itself, and copies by sending `ESC ] 52 ; c ; <base64> BEL` whenever it has
 * no clipboard tool of its own (a container, SSH, a Linux host without
 * wl-copy or xclip). The drag never makes an xterm selection, so the
 * terminal's own Copy stays disabled too.
 *
 * Only writes are honoured. A read request (`?`) is never answered, so a
 * program cannot read the clipboard through the terminal, and an empty
 * payload (a "clear") is ignored.
 *
 * A write is accepted only shortly after the user typed or clicked in this
 * terminal. A copy follows a gesture (the mouse-up that ends a drag, Enter on
 * `/copy`), whereas output replayed into a remounted terminal, or a program
 * running unattended in a background tab, would otherwise overwrite the
 * clipboard with no gesture at all.
 */
export const OSC_52 = 52;

/** How long after the last input in this terminal a clipboard write is accepted. */
export const OSC_52_INPUT_WINDOW_MS = 5_000;

/** Upper bound on the base64 payload, about 3 MiB of text. */
export const MAX_OSC_52_BASE64_LENGTH = 4 * 1024 * 1024;

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decode an OSC 52 payload (`Pc;Pd`) into the text to copy, or `null` when
 * it is not a write this terminal accepts (a query, a clear, malformed or
 * oversized data).
 */
export function decodeOsc52Write(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;
  const payload = data.slice(separator + 1).replace(/\s+/g, "");
  if (payload === "" || payload === "?") return null;
  if (payload.length > MAX_OSC_52_BASE64_LENGTH) return null;
  if (payload.length % 4 === 1 || !BASE64_PATTERN.test(payload)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export interface Osc52ClipboardOptions {
  writeText: (text: string) => Promise<void>;
  onError?: (error: unknown) => void;
  now?: () => number;
}

type Osc52Terminal = Pick<Terminal, "parser" | "onData" | "onBinary">;

/** Route OSC 52 clipboard writes from programs in `terminal` to the system clipboard. */
export function installOsc52ClipboardHandler(
  terminal: Osc52Terminal,
  { writeText, onError, now = Date.now }: Osc52ClipboardOptions,
): IDisposable {
  let lastInputAt = Number.NEGATIVE_INFINITY;
  const markInput = () => {
    lastInputAt = now();
  };
  const disposables: IDisposable[] = [
    terminal.onData(markInput),
    terminal.onBinary(markInput),
    terminal.parser.registerOscHandler(OSC_52, (data) => {
      if (now() - lastInputAt > OSC_52_INPUT_WINDOW_MS) return true;
      const text = decodeOsc52Write(data);
      if (text === null) return true;
      void writeText(text).catch((error: unknown) => onError?.(error));
      return true;
    }),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables.splice(0)) disposable.dispose();
    },
  };
}
