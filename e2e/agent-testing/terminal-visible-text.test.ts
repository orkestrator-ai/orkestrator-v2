import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { waitCode } from "./local-gateway-transport-cpu-page";
import { TERMINAL_VISIBLE_TEXT_PAGE_SOURCE, terminalVisibleText } from "./terminal-visible-text";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

/** A beelink-style prompt: OSC 3008 context marks, a title and colours around the text. */
const BEELINK_PROMPT =
  `${ESC}]3008;start=7f3c;user=node;hostname=beelink2;machineid=0;type=shell${ST}` +
  `${ESC}]0;node@beelink2: ~/project${BEL}` +
  `${ESC}[1;32mnode@beelink2${ESC}[0m:${ESC}[1;34m~/project${ESC}[0m$ `;

const SAMPLES = [
  `${BEELINK_PROMPT}echo ready\r\nready\r\n`,
  `before${ESC}P1$r0;1m${ST}after\n`,
  `${ESC}=keypad on${ESC}>keypad off${ESC}7saved${ESC}8${ESC}(Breset${ESC}[m${ESC}M\n`,
  `${ESC}[?2004hbracketed${ESC}[?2004l${ESC}[2K${ESC}[1G\tindented\n`,
  `bell${BEL}back\bspace\x7fdel\x00nul\x0bvt\x0cff\n`,
];

describe("terminalVisibleText", () => {
  test("a beelink prompt leaves only the prompt text, so whole lines compare", () => {
    const lines = terminalVisibleText(SAMPLES[0]!).split("\n");
    expect(lines).toEqual(["node@beelink2:~/project$ echo ready", "ready", ""]);
    expect(lines).toContain("ready");
  });

  test("DCS strings, keypad modes, charset selections and other escapes are removed", () => {
    expect(terminalVisibleText(SAMPLES[1]!)).toBe("beforeafter\n");
    expect(terminalVisibleText(SAMPLES[2]!)).toBe("keypad onkeypad offsavedreset\n");
  });

  test("CSI sequences and C0 controls go; newlines and tabs stay", () => {
    expect(terminalVisibleText(SAMPLES[3]!)).toBe("bracketed\tindented\n");
    expect(terminalVisibleText(SAMPLES[4]!)).toBe("bellbackspacedelnulvtff\n");
  });

  test("an OSC string ended by BEL inside other text is removed whole", () => {
    expect(terminalVisibleText(`a${ESC}]133;A${BEL}b${ESC}]133;B${ST}c`)).toBe("abc");
  });

  test("plain text is unchanged", () => {
    expect(terminalVisibleText("line one\n\tline two\n")).toBe("line one\n\tline two\n");
  });
});

describe("the page copy", () => {
  // Evaluate the page source as the renderer would.
  const pageVisibleText = new Function(`return ${TERMINAL_VISIBLE_TEXT_PAGE_SOURCE};`)() as (
    text: string,
  ) => string;

  test("strips exactly what the helper strips", () => {
    for (const sample of SAMPLES) expect(pageVisibleText(sample)).toBe(terminalVisibleText(sample));
  });

  test("is the one the in-page terminal wait uses", () => {
    expect(waitCode("session-1", "marker")).toContain(TERMINAL_VISIBLE_TEXT_PAGE_SOURCE);
  });
});

test("no agent-testing source keeps its own copy of the escape rules", () => {
  const directory = import.meta.dirname;
  const offenders = readdirSync(directory)
    .filter((name) => name.endsWith(".ts") && !name.startsWith("terminal-visible-text"))
    .filter((name) => {
      const source = readFileSync(path.join(directory, name), "utf8");
      // The OSC rule's opening, as every copy wrote it, in code or in page source.
      return (
        source.includes(String.raw`\x1b\][^\x07\x1b]*`) ||
        source.includes(String.raw`\\x1b\\][^\\x07\\x1b]*`)
      );
    });
  expect(offenders).toEqual([]);
});
