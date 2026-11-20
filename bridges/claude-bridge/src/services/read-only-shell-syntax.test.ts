import { describe, expect, test } from "bun:test";
import {
  parseReadOnlyShell,
  quoteShellWord,
  serializeShellList,
  type ShellListItem,
} from "./read-only-shell-syntax.js";

/** The words of each command, flattened across the list, for compact expectations. */
function commands(items: ShellListItem[] | null): string[][] | null {
  return items ? items.flatMap((item) => item.pipeline) : null;
}

describe("parseReadOnlyShell", () => {
  test("quoted words decode to exactly the words the shell passes on", () => {
    const cases: [string, string[]][] = [
      [`grep -n "a\\|b" file`, ["grep", "-n", "a\\|b", "file"]],
      [`grep -n 'foo bar' x`, ["grep", "-n", "foo bar", "x"]],
      [`sed -n '1,$p' x`, ["sed", "-n", "1,$p", "x"]],
      [`grep "say \\"hi\\" \\\\ \\$x"`, ["grep", 'say "hi" \\ $x']],
      [`grep ''`, ["grep", ""]],
      [`git log --format=%h\\ %s`, ["git", "log", "--format=%h %s"]],
      [`git log "--format=%h %s"`, ["git", "log", "--format=%h %s"]],
      [`grep a'b'"c"d`, ["grep", "abcd"]],
      [`grep "*.ts [x] (y) {z} <w> ; && | ~"`, ["grep", "*.ts [x] (y) {z} <w> ; && | ~"]],
      [`git show HEAD~1:a.ts`, ["git", "show", "HEAD~1:a.ts"]],
      [`grep a#b c`, ["grep", "a#b", "c"]],
    ];
    for (const [command, words] of cases) {
      expect({ command, words: commands(parseReadOnlyShell(command)) }).toEqual({
        command,
        words: [words],
      });
    }
  });

  test("lists and pipelines keep their operators", () => {
    expect(parseReadOnlyShell("git diff a..b --stat; git log -1 && ls || pwd")).toEqual([
      { pipeline: [["git", "diff", "a..b", "--stat"]] },
      { operator: ";", pipeline: [["git", "log", "-1"]] },
      { operator: "&&", pipeline: [["ls"]] },
      { operator: "||", pipeline: [["pwd"]] },
    ]);
    expect(parseReadOnlyShell("git show a:b | grep -n x | wc -l\ncat y\n")).toEqual([
      {
        pipeline: [
          ["git", "show", "a:b"],
          ["grep", "-n", "x"],
          ["wc", "-l"],
        ],
      },
      { operator: ";", pipeline: [["cat", "y"]] },
    ]);
    // A newline after `&&`, `||` or `|` continues the command.
    expect(commands(parseReadOnlyShell("ls &&\n  pwd |\n wc"))).toEqual([["ls"], ["pwd"], ["wc"]]);
    expect(commands(parseReadOnlyShell("ls;"))).toEqual([["ls"]]);
  });

  test("a whole-command assignment is substituted into later commands and dropped", () => {
    expect(
      parseReadOnlyShell(
        'D=.orkestrator/review; cat $D/a.txt "${D}/b c.txt"\nB=HEAD~1 && git diff $B..HEAD',
      ),
    ).toEqual([
      { pipeline: [["cat", ".orkestrator/review/a.txt", ".orkestrator/review/b c.txt"]] },
      { operator: ";", pipeline: [["git", "diff", "HEAD~1..HEAD"]] },
    ]);
    // Single quotes do not expand.
    expect(commands(parseReadOnlyShell("D=x; grep '$D' f"))).toEqual([["grep", "$D", "f"]]);
  });

  test("anything whose words are not known before it runs is refused", () => {
    for (const command of [
      "cat a > b",
      "cat < a",
      "ls &",
      "ls & rm x",
      "cat a |& wc",
      "echo $(rm x)",
      "echo `rm x`",
      'echo "$(rm x)"',
      'echo "`rm x`"',
      "echo $HOME",
      "echo ${HOME}",
      'echo "$HOME"',
      "echo $1",
      "echo $?",
      "D=x; echo ${D:-y}",
      "cat *.ts",
      "cat a?.ts",
      "cat [ab].ts",
      "(ls)",
      "{ ls; }",
      "echo {a,b}",
      "! ls",
      "ls # comment",
      "cat ~/.ssh/id",
      "cat --file=~/x",
      "cat a:~/x",
      "cat =ls",
      "ls \\\npwd",
      "cat 'unterminated",
      'cat "unterminated',
      "ls ;; pwd",
      "; ls",
      "ls && ",
      "ls ||",
      "ls |",
      "| ls",
      "ls | | wc",
      "ls\r",
      // Assignments only where they are certain to run, and never alone.
      "D=x",
      "ls && D=x; cat $D",
      "D=x || cat $D",
      "D='a b'; cat $D",
      "D=*; cat $D",
      "cat $D; D=x",
      "D=x cat $D",
    ]) {
      expect({ command, parsed: parseReadOnlyShell(command) }).toEqual({ command, parsed: null });
    }
  });

  test("an assignment that is not a whole command stays a word for the policy to judge", () => {
    expect(commands(parseReadOnlyShell("D=x cat y"))).toEqual([["D=x", "cat", "y"]]);
    expect(commands(parseReadOnlyShell('"D"=x'))).toEqual([["D=x"]]);
    expect(commands(parseReadOnlyShell("ls | D=x"))).toEqual([["ls"], ["D=x"]]);
  });
});

describe("serializeShellList", () => {
  test("plain words run as written and anything else is single-quoted", () => {
    expect(quoteShellWord("HEAD~1..HEAD")).toBe("HEAD~1..HEAD");
    expect(quoteShellWord("--format=%h")).toBe("--format=%h");
    expect(quoteShellWord("a b")).toBe("'a b'");
    expect(quoteShellWord("it's")).toBe("'it'\\''s'");
    expect(quoteShellWord("")).toBe("''");
    expect(quoteShellWord("~x")).toBe("'~x'");
    expect(quoteShellWord("a=~x")).toBe("'a=~x'");
    expect(quoteShellWord("=ls")).toBe("'=ls'");
    expect(quoteShellWord("HEAD^")).toBe("'HEAD^'");
    expect(quoteShellWord("$x")).toBe("'$x'");
  });

  test("a parsed list serializes to text that parses back to the same list", () => {
    for (const command of [
      `git show a:b | grep -n "x\\|y" | wc -l; git diff a..b && ls`,
      `D=dir; cat "$D/it's here" || pwd`,
      `grep -nE 'FAIL|✗' f\nsed -n '1,$p' g`,
    ]) {
      const items = parseReadOnlyShell(command)!;
      expect(parseReadOnlyShell(serializeShellList(items))).toEqual(items);
    }
    expect(serializeShellList(parseReadOnlyShell("D=x\ncat $D/a; ls && pwd")!)).toBe(
      "cat x/a; ls && pwd",
    );
  });
});
