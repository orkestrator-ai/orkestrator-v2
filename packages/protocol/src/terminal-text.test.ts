import { describe, expect, test } from "bun:test";

import { detectHumanPrompt, HumanPromptScanner } from "./human-prompts";
import { normalizeTerminalText, TerminalTextBuffer } from "./terminal-text";

const E = "\u001b";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_CHARS = new RegExp(`[${FRAMES.join("")}]`, "u");

/** Every way of cutting `raw` into two chunks gives the same text as one write. */
function expectChunkInvariant(raw: string): void {
  const whole = normalizeTerminalText(raw);
  for (let cut = 0; cut <= raw.length; cut += 1) {
    const buffer = new TerminalTextBuffer();
    buffer.write(raw.slice(0, cut));
    buffer.write(raw.slice(cut));
    expect(buffer.toString()).toBe(whole);
  }
  // And one character at a time.
  const single = new TerminalTextBuffer();
  for (const char of raw) single.write(char);
  expect(single.toString()).toBe(whole);
}

/**
 * npm 10/11's progress spinner, as a PTY records it: each frame is drawn at
 * column 1 (`readline.cursorTo(0)` → `ESC[1G`) after clearing the line
 * (`readline.clearLine(1)` → `ESC[0K`), and cleared again before a real line
 * is printed. The cursor is hidden while it spins.
 */
function npmSpinner(frames: number, start = 0): string {
  let out = "";
  for (let i = 0; i < frames; i += 1) {
    out += `${E}[1G${E}[0K${FRAMES[(start + i) % FRAMES.length]}`;
  }
  return out;
}
const CLEAR_SPINNER = `${E}[1G${E}[0K`;
const LOGIN_URL =
  "https://www.npmjs.com/login?next=/login/cli/b4cc90fe-8f7e-465f-9d29-702dfda0a967";
/** `bunx npm login` from the bug report, with its spinner interleaved. */
const NPM_LOGIN_TRANSCRIPT = [
  `${E}[?25l`,
  npmSpinner(14),
  CLEAR_SPINNER,
  `${E}[94mnpm${E}[39m ${E}[94mnotice${E}[39m Log in on https://registry.npmjs.org/\r\n`,
  npmSpinner(2, 3),
  CLEAR_SPINNER,
  `Login at:\r\n`,
  npmSpinner(1, 5),
  CLEAR_SPINNER,
  `${LOGIN_URL}\r\n`,
  `Press ENTER to open in the browser...`,
  `${E}[?25h`,
].join("");

describe("in-place spinner redraws", () => {
  test("ESC[1G + ESC[0K frames leave only the latest frame, then the next line", () => {
    const raw = `${npmSpinner(12)}${CLEAR_SPINNER}${npmSpinner(1, 4)}\r\nDone\r\n`;
    expect(normalizeTerminalText(raw)).toBe(`${FRAMES[4]}\nDone\n`);
    expect(normalizeTerminalText(npmSpinner(12))).toBe(FRAMES[11 % FRAMES.length]);
  });

  test("ESC[G and ESC[K (default parameters) behave like ESC[1G and ESC[0K", () => {
    expect(normalizeTerminalText(`⠋ working${E}[G${E}[K⠙ working${E}[G${E}[K⠹ done\n`)).toBe(
      "⠹ done\n",
    );
  });

  test("a bare carriage-return spinner keeps the latest frame", () => {
    expect(normalizeTerminalText(`\r⠋ fetch\r⠙ fetch\r⠹ fetch\r\nnext\n`)).toBe("⠹ fetch\nnext\n");
  });

  test("a backspace spinner keeps the latest frame", () => {
    expect(normalizeTerminalText(`Installing ⠋\b⠙\b⠹\b⠸\b \nnext\n`)).toBe("Installing  \nnext\n");
    expect(normalizeTerminalText(`Installing |\b/\b-\b\\`)).toBe("Installing \\");
  });

  test("a frame is never concatenated with the next real line", () => {
    const text = normalizeTerminalText(NPM_LOGIN_TRANSCRIPT);
    expect(SPINNER_CHARS.test(text)).toBe(false);
  });
});

describe("the npm login transcript from the bug", () => {
  test("normalises to the notice, Login at:, the URL and the ENTER prompt", () => {
    expect(normalizeTerminalText(NPM_LOGIN_TRANSCRIPT)).toBe(
      [
        "npm notice Log in on https://registry.npmjs.org/",
        "Login at:",
        LOGIN_URL,
        "Press ENTER to open in the browser...",
      ].join("\n"),
    );
  });

  test("the sign-in link and ENTER prompt are still detected", () => {
    expect(detectHumanPrompt(NPM_LOGIN_TRANSCRIPT)).toMatchObject({
      kind: "sign-in",
      url: LOGIN_URL,
      wantsEnter: true,
      text: `Login at: ${LOGIN_URL}`,
    });
  });

  test("the scanner announces once while the spinner redraws, with escapes split across chunks", () => {
    // Each escape sequence is cut after its `ESC[`, so every redraw arrives
    // in two writes; lines arrive whole, as a PTY usually delivers them.
    const chunks = NPM_LOGIN_TRANSCRIPT.split(/(?=\u001b)/).flatMap((piece) => [
      piece.slice(0, 2),
      piece.slice(2),
    ]);
    const scanner = new HumanPromptScanner();
    const changes = [];
    for (const chunk of chunks) {
      const change = scanner.push(chunk);
      if (change) changes.push(change);
    }
    expect(scanner.prompt).toMatchObject({ kind: "sign-in", url: LOGIN_URL, wantsEnter: true });
    // The link and its ENTER instruction arrive together; spinner frames
    // before them never announce, and nothing after re-announces.
    expect(changes).toHaveLength(1);
    expect(changes[0]).toHaveProperty("prompt.url", LOGIN_URL);
  });

  test("splitting the transcript anywhere gives the same text", () => {
    expectChunkInvariant(NPM_LOGIN_TRANSCRIPT);
  });
});

describe("cursor movement", () => {
  test("CSI G moves to a 1-based column (0 and missing mean 1)", () => {
    expect(normalizeTerminalText(`abcdef${E}[3GX`)).toBe("abXdef");
    expect(normalizeTerminalText(`abcdef${E}[0GX`)).toBe("Xbcdef");
    expect(normalizeTerminalText(`abcdef${E}[GX`)).toBe("Xbcdef");
  });

  test("CSI C and D move forward and back; forward past the end pads", () => {
    expect(normalizeTerminalText(`abcdef${E}[3DX`)).toBe("abcXef");
    expect(normalizeTerminalText(`abcdef${E}[DX`)).toBe("abcdeX");
    expect(normalizeTerminalText(`abcdef${E}[99DX`)).toBe("Xbcdef");
    expect(normalizeTerminalText(`ab${E}[2CX`)).toBe("ab  X");
    expect(normalizeTerminalText(`abcdef\r${E}[CX`)).toBe("aXcdef");
    // A move with no write after it adds nothing.
    expect(normalizeTerminalText(`ab${E}[5C`)).toBe("ab");
  });

  test("forward moves stay forward after writing beyond the movement limit", () => {
    const line = "x".repeat(5000);
    for (const command of ["C", "a"]) {
      for (const [parameter, distance] of [
        ["", 1],
        ["0", 1],
        ["7", 7],
        ["99999", 4096],
      ] as const) {
        expect(normalizeTerminalText(`${line}${E}[${parameter}${command}Y`)).toBe(
          `${line}${" ".repeat(distance)}Y`,
        );
      }
    }
  });

  test("a carriage return overwrites in place, as a terminal does", () => {
    expect(normalizeTerminalText("progress 10%\rprogress 100%\n")).toBe("progress 100%\n");
    expect(normalizeTerminalText("long text\rshort\n")).toBe("shorttext\n");
    expect(normalizeTerminalText("long text\r\u001b[Kshort\n")).toBe("short\n");
  });

  test("backspace stops at column 0 and does not erase", () => {
    expect(normalizeTerminalText("ab\b\b\b\bX")).toBe("Xb");
    expect(normalizeTerminalText("abc\b")).toBe("abc");
  });

  test("CSI A and F move up; the lines are replaced instead of appended", () => {
    // Multi-line progress: three bars, redrawn by moving up three lines.
    const raw =
      "a: 0%\nb: 0%\nc: 0%\n" +
      `${E}[3A${E}[2Ka: 50%\n${E}[2Kb: 20%\n${E}[2Kc: 90%\n` +
      `${E}[3A${E}[2Ka: 100%\n${E}[2Kb: 100%\n${E}[2Kc: 100%\n` +
      "all done\n";
    expect(normalizeTerminalText(raw)).toBe("a: 100%\nb: 100%\nc: 100%\nall done\n");
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2F${E}[0KONE`)).toBe("ONE\ntwo\nthree");
    expect(normalizeTerminalText(`one\ntwo${E}[A${E}[2K\rx`)).toBe("x\ntwo");
  });

  test("cursor up stops at the first line held", () => {
    expect(normalizeTerminalText(`one\ntwo${E}[99A\rX`)).toBe("Xne\ntwo");
  });

  test("CSI B and E move down but never past the last line", () => {
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2A${E}[2G${E}[BX`)).toBe("one\ntXo\nthree");
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2A${E}[EX`)).toBe("one\nXwo\nthree");
    expect(normalizeTerminalText(`one\ntwo${E}[5B\rX`)).toBe("one\nXwo");
  });

  test("a newline on an earlier line moves down without adding a line", () => {
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2A\nX`)).toBe("one\nXwo\nthree");
  });

  test("save and restore cursor (CSI s/u and ESC 7/8)", () => {
    expect(normalizeTerminalText(`ab${E}[scdef${E}[uX`)).toBe("abXdef");
    expect(normalizeTerminalText(`ab${E}7cd\nef${E}8X`)).toBe("abXd\nef");
  });

  test("CSI H applies its column only", () => {
    expect(normalizeTerminalText(`abc${E}[HX`)).toBe("Xbc");
    expect(normalizeTerminalText(`abc${E}[5;2HX`)).toBe("aXc");
  });
});

describe("erasing", () => {
  test("CSI K: 0 to the end, 1 to the start, 2 the whole line", () => {
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[0K`)).toBe("ab");
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[K`)).toBe("ab");
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[1K`)).toBe("   def");
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[1KX`)).toBe("  Xdef");
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[2K`)).toBe("");
    // Erasing the whole line keeps the cursor's column.
    expect(normalizeTerminalText(`abcdef${E}[3G${E}[2KX`)).toBe("  X");
  });

  test("CSI J: 0 erases below, 1 above, 2 and 3 clear everything", () => {
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2A${E}[2G${E}[J`)).toBe("o");
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[2A${E}[2G${E}[0J`)).toBe("o");
    expect(normalizeTerminalText(`one\ntwo\nthree${E}[A${E}[2G${E}[1J`)).toBe("\n  o\nthree");
    expect(normalizeTerminalText(`one\ntwo${E}[2Jthree`)).toBe("   three");
    expect(normalizeTerminalText(`one\ntwo${E}[H${E}[2J${E}[3Jfresh\n`)).toBe("fresh\n");
  });
});

describe("ignored and dropped sequences", () => {
  test("SGR colours and cursor visibility have no effect", () => {
    expect(
      normalizeTerminalText(`${E}[?25l${E}[1;31mred${E}[0m ${E}[38;5;208mo${E}[m${E}[?25h`),
    ).toBe("red o");
  });

  test("OSC hyperlinks and titles are removed, with BEL or ST", () => {
    expect(
      normalizeTerminalText(
        `${E}]0;title\u0007${E}]8;;https://x${E}\\link${E}]8;;${E}\\ ok${E}]133;A\u0007`,
      ),
    ).toBe("link ok");
  });

  test("DCS, APC, PM and SOS strings are removed", () => {
    expect(
      normalizeTerminalText(`a${E}Pq#0;1${E}\\b${E}_apc${E}\\c${E}^pm${E}\\d${E}Xsos${E}\\e`),
    ).toBe("abcde");
  });

  test("unknown CSI, nF and two-byte escapes are removed", () => {
    expect(normalizeTerminalText(`a${E}[5nb${E}[>0cc${E}[6 qd${E}(Be${E}=f${E}cg`)).toBe("abcdefg");
    expect(normalizeTerminalText(`a${E}[1;2;3;4zb`)).toBe("ab");
  });

  test("controls without a visible effect are dropped; tabs are kept", () => {
    expect(normalizeTerminalText("a\u0007b\u0000c\u007fd\te")).toBe("abcd\te");
  });

  test("a malformed CSI is dropped and the byte that broke it still applies", () => {
    expect(normalizeTerminalText(`ab${E}[12\ncd`)).toBe("ab\ncd");
    expect(normalizeTerminalText(`ab${E}[1${E}[2Dx`)).toBe("x" + "b");
  });

  test("an unterminated OSC cannot hide the rest of the output forever", () => {
    const text = normalizeTerminalText(`${E}]8;;${"x".repeat(9000)}\nvisible`);
    expect(text.endsWith("\nvisible")).toBe(true);
  });

  test("an incomplete escape at the end is held, not shown", () => {
    for (const tail of [`${E}`, `${E}[`, `${E}[1`, `${E}]8;;http`, `${E}]8;;x${E}`]) {
      expect(normalizeTerminalText(`done${tail}`)).toBe("done");
    }
  });
});

describe("chunk boundaries", () => {
  test("escape sequences split between chunks apply as if whole", () => {
    const buffer = new TerminalTextBuffer();
    for (const chunk of [
      "⠋",
      `${E}`,
      "[",
      "1",
      "G",
      `${E}[`,
      "0K⠙",
      `${E}[1`,
      `G${E}[0`,
      "K",
      "ok\r",
      "\n",
    ]) {
      buffer.write(chunk);
    }
    expect(buffer.toString()).toBe("ok\n");
  });

  test("every cut point of a mixed sequence gives the same text", () => {
    expectChunkInvariant(
      `a: 0%\r\nb: 0%\r\n${E}[2A${E}[2Ka: 50%${E}]8;;https://x\u0007L${E}]8;;${E}\\\r\n` +
        `${E}[1;32mb${E}[0m 😀\b\b😀\r\n⠋${E}[1G${E}[0K⠙\bX`,
    );
  });

  test("budget exhaustion is independent of future input and write boundaries", () => {
    const suffix = "z".repeat(4000);
    const padding = `${E}[4096CX\n`.repeat(3);
    const erasing = `${"x".repeat(4000)}${E}[2000G${`${E}[1K`.repeat(12)}`;
    for (const prefix of [padding, erasing, padding + erasing]) {
      const raw = prefix + suffix;
      const expected = normalizeTerminalText(raw);
      // Exercise every escape boundary and the large suffix independently.
      for (const size of [1, 2, 7, prefix.length]) {
        const buffer = new TerminalTextBuffer();
        for (let index = 0; index < raw.length; index += size) {
          buffer.write(raw.slice(index, index + size));
        }
        expect(buffer.toString()).toBe(expected);
      }
    }
  });

  test("a surrogate pair split across chunks stays one character", () => {
    const buffer = new TerminalTextBuffer();
    buffer.write("x\ud83d");
    buffer.write("\ude00y\bz");
    expect(buffer.toString()).toBe("x😀z");
  });
});

describe("bounds", () => {
  test("huge cursor moves are clamped and padding stays within budget", () => {
    const raw = `${E}[999999999CX`.repeat(200);
    const text = normalizeTerminalText(raw);
    expect(text.length).toBeLessThanOrEqual(raw.length * 5 + 4 * 1024);
    expect(text.endsWith("X")).toBe(true);
  });

  test("repeated erase-to-start of a long line stays within budget", () => {
    const raw = `${"x".repeat(4000)}${E}[2000G${`${E}[1K`.repeat(5000)}`;
    const started = performance.now();
    expect(normalizeTerminalText(raw).length).toBe(4000);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("repeated erase-above skips cleared rows and bounds traversal after rewrites", () => {
    const rows = 16000;
    const buffer = new TerminalTextBuffer();
    buffer.write("x\n".repeat(rows));
    // Count row replacements rather than using a wall-clock threshold. This
    // detects repeated scans of empty rows without depending on machine speed.
    const state = buffer as unknown as { lines: string[][] };
    let replacements = 0;
    state.lines = new Proxy(state.lines, {
      set(target, key, value) {
        if (typeof key === "string" && /^\d+$/.test(key)) replacements += 1;
        return Reflect.set(target, key, value);
      },
    });
    buffer.write(`${E}[1J`.repeat(rows / 2));
    expect(buffer.toString()).toBe("\n".repeat(rows));
    expect(replacements).toBeLessThanOrEqual(rows * 2);

    // A write above the cleared prefix must still be cleared on the next J.
    // Repeatedly invalidating that prefix must remain budgeted, too.
    const rewrites = `${E}7${E}[4096A\rY${E}8${E}[1J`.repeat(100);
    buffer.write(rewrites);
    expect(buffer.toString()).toBe("\n".repeat(rows));
    const inputChars = rows * 2 + (rows / 2) * 4 + rewrites.length;
    expect(replacements).toBeLessThanOrEqual(4096 + inputChars * 4 + rows / 2 + 100);
  });

  test("erase-above handles moving within the cleared prefix and a full reset", () => {
    expect(normalizeTerminalText(`a\nb\nc${E}[1J${E}[A${E}[1JX`)).toBe("\n X\n");
    expect(normalizeTerminalText(`a\nb${E}[1J${E}[2J\rx\ny${E}[1J`)).toBe("\n");
    expect(normalizeTerminalText(`a\nb\nc${E}[1J${E}[2A${E}[J\rx\ny${E}[1J`)).toBe("\n");
  });

  test("redrawing a long line many times is linear", () => {
    const line = "=".repeat(200);
    const raw = `${line}\r`.repeat(2000) + "\n";
    expect(normalizeTerminalText(raw)).toBe(`${line}\n`);
  });
});
