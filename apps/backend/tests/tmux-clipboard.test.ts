import { expect, test } from "bun:test";
import { TmuxClipboardControlParser, TmuxClipboardParser } from "../src/core/tmux-clipboard";

test("clipboard stream preserves chunk boundaries, consumes queries and bounds escapes", () => {
  const output: string[] = [];
  const parser = new TmuxClipboardParser((sequence) => output.push(sequence));
  for (const chunk of ["screen\x1b", "]52;c;YQ", "==\x1b", "\\more screen\x1b]52;c;?\x07"])
    parser.write(chunk);
  expect(output).toEqual(["\x1b]52;c;YQ==\x07", "\x1b]52;c;?\x07"]);
  parser.write(`\x1b]52;c;${"A".repeat(4 * 1024 * 1024 + 33)}\x07`);
  parser.write("\x1b]52;c;Yg==\x07");
  expect(output.at(-1)).toBe("\x1b]52;c;Yg==\x07");
  expect(output).toHaveLength(3);
});

test("control output unescapes only the attached pane, including DCS passthrough", () => {
  const output: string[] = [];
  const parser = new TmuxClipboardControlParser(
    "%1",
    new TmuxClipboardParser((value) => output.push(value)),
  );
  parser.write("%output %2 \\033]52;c;YQ==\\007\n");
  parser.write("%output %1 \\033Ptmux;\\033\\033]52;c;");
  parser.write("Yg==\\007\\033\\134\r\n");
  expect(output).toEqual(["\x1b]52;c;Yg==\x07"]);
});
