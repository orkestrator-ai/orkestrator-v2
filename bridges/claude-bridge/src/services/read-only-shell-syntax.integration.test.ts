import { describe, expect, test } from "bun:test";
import { parseReadOnlyShell, serializeShellList } from "./read-only-shell-syntax.js";

/**
 * The read-only policy judges the words `parseReadOnlyShell` reads, and the
 * hook runs `serializeShellList` of them. Both claims are checked here against
 * a real bash: for every admitted command, bash passes each program exactly
 * the words the parser read, from the original text and from the serialized
 * one. Each program name is replaced by a `printf` that prints its arguments
 * NUL-separated, so nothing else runs.
 *
 * Slow tier (`*.integration.test.ts`): it starts a shell per case.
 */

/**
 * Admitted commands, each with every program name prefixed by the printer `p`
 * (assignment-only commands left as they are), so bash runs only printers.
 */
const ADMITTED: [string, string][] = [
  [`grep -n "a\\|b" file`, `p grep -n "a\\|b" file`],
  [`grep -n 'foo bar' x`, `p grep -n 'foo bar' x`],
  [`sed -n '1,$p' x`, `p sed -n '1,$p' x`],
  [`grep "say \\"hi\\" \\\\ \\$x \\n"`, `p grep "say \\"hi\\" \\\\ \\$x \\n"`],
  [`grep ''`, `p grep ''`],
  [`git log --format=%h\\ %s`, `p git log --format=%h\\ %s`],
  [`git log "--format=%h %s" HEAD~1..HEAD`, `p git log "--format=%h %s" HEAD~1..HEAD`],
  [`grep a'b'"c"d`, `p grep a'b'"c"d`],
  [`grep "*.ts [x] (y) {z} <w> ; && | ~ !"`, `p grep "*.ts [x] (y) {z} <w> ; && | ~ !"`],
  [`grep -nE 'FAIL|✗|×' f`, `p grep -nE 'FAIL|✗|×' f`],
  [`grep a#b c`, `p grep a#b c`],
  [`grep "it's" 'say "x"'`, `p grep "it's" 'say "x"'`],
  [`D=.orkestrator/r1; cat $D/a "\${D}/b c" $D`, `D=.orkestrator/r1; p cat $D/a "\${D}/b c" $D`],
  [`B=HEAD~1\ngit diff $B..HEAD -- "a b"`, `B=HEAD~1\np git diff $B..HEAD -- "a b"`],
  // `p` always succeeds, so a command after `||` would not run here.
  [`cat a; cat b && cat c`, `p cat a; p cat b && p cat c`],
  [`cat a |\n wc -l`, `p cat a |\n p wc -l`],
];

/** What bash passes each command of `text`, with every program made a printer. */
function bashWords(text: string, commands: number): string[][] {
  // `p` prints its arguments, each followed by NUL, then a record separator,
  // to stderr: a pipeline stage's stdout is the next stage's input. One
  // `printf` per record, so concurrent stages cannot interleave within one.
  const script = `p() { printf '%s\\0' "$@" $'\\x1e' >&2; }\n${text}`;
  const result = Bun.spawnSync(["bash", "--norc", "--noprofile", "-c", script], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  const records = result.stderr.toString().split("\x1e\0").slice(0, commands);
  // Pipeline stages run concurrently, so compare without their order.
  return records.map((record) => record.split("\0").slice(0, -1)).sort();
}

/** `text` with each command's program name replaced by `p`, by position in the original. */
function asPrinters(items: NonNullable<ReturnType<typeof parseReadOnlyShell>>): string {
  return serializeShellList(
    items.map((item) => ({
      ...item,
      pipeline: item.pipeline.map((words) => ["p", ...words]),
    })),
  );
}

describe("parseReadOnlyShell agrees with bash", () => {
  test("each admitted command passes bash's own words, as written and serialized", () => {
    for (const [command, prefixed] of ADMITTED) {
      const items = parseReadOnlyShell(command);
      expect({ command, admitted: items !== null }).toEqual({ command, admitted: true });
      // Every command here runs (`p` always succeeds) and prints one record.
      const parsed = items!.flatMap((item) => item.pipeline);
      const flat = [...parsed].sort();
      expect({ command, bash: bashWords(prefixed, flat.length) }).toEqual({ command, bash: flat });
      expect({ command, serialized: bashWords(asPrinters(items!), flat.length) }).toEqual({
        command,
        serialized: flat,
      });
    }
  });
});
