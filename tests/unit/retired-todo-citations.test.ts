import { describe, expect, test } from "bun:test";
import type { SourceIndex } from "../source-guards/repository-index";
import {
  checkRetiredTodoCitations,
  findRetiredTodoCitations,
  liveTodoNumbers,
} from "../source-guards/retired-todo-citations";

/** An in-memory listing: the guard reads nothing but `files` and `read`. */
function index(files: Record<string, string | null>): SourceIndex {
  return {
    files: Object.keys(files).sort(),
    read: (relative) => files[relative] ?? null,
  };
}

const LIVE = { "docs/todo/cross-cutting/7568-manual-test-checklist.md": "# Checklist\n" };

describe("retired to-do citations", () => {
  test("live numbers come from the to-do files, in any area", () => {
    const numbers = liveTodoNumbers(
      index({
        ...LIVE,
        "docs/todo/mcp/1234-something.md": "",
        "docs/todo/0000-index.md": "",
        "docs/todo/mcp/0000-index.md": "",
        "docs/tests/flaky-tests/backend/4321-a-flake.md": "",
      }),
    );
    expect([...numbers].sort()).toEqual(["0000", "1234", "7568"]);
  });

  test("an unmarked citation of a missing to-do is refused, in every spelling", () => {
    const findings = findRetiredTodoCitations(
      index({
        ...LIVE,
        "apps/backend/src/a.ts": "// reads once (to-do 1202 task 8).\n",
        "apps/web/src/b.tsx": "/** Todo 7220: the port. */\n",
        "scripts/c.sh": "# see todo 0049 and to-dos 5180 and 5181\n",
        ".github/workflows/d.yml": "      # hosts refused (TO-DO #6100).\n",
      }),
    );
    expect(findings.map(({ file, line, number }) => `${file}:${line}:${number}`)).toEqual([
      ".github/workflows/d.yml:1:6100",
      "apps/backend/src/a.ts:1:1202",
      "apps/web/src/b.tsx:1:7220",
      "scripts/c.sh:1:0049",
      "scripts/c.sh:1:5180",
      "scripts/c.sh:1:5181",
    ]);
  });

  test("a deleted but still indexed to-do is retired", () => {
    const source = index({
      ...LIVE,
      "docs/todo/x/1234-a.md": null,
      "apps/a.ts": "// to-do 1234",
    });
    expect(liveTodoNumbers(source).has("1234")).toBe(false);
    expect(findRetiredTodoCitations(source).map((finding) => finding.number)).toEqual(["1234"]);
  });

  test("every number in a plural list is checked, including after a live number", () => {
    const source = index({
      ...LIVE,
      "apps/a.ts": [
        "// to-dos 7568 and 1234 task 8",
        "// TODOS 7568, 2345, and 3456",
        "// to-dos 7568 or 4567",
        "// to-dos 5678, 6789 (retired)",
        "// to-do 7568 task 7890; unrelated number 8901",
      ].join("\n"),
    });
    expect(findRetiredTodoCitations(source).map(({ line, number }) => [line, number])).toEqual([
      [1, "1234"],
      [2, "2345"],
      [2, "3456"],
      [3, "4567"],
    ]);
  });

  test("Swift and other comment-bearing source types are scanned", () => {
    const source = index({
      "apps/ios/X.swift": "/// To-do 1234",
      "apps/ios/Retired.swift": "/// To-do 2345 (retired)",
      "apps/web/a.css": "/* to-do 1234 */",
      "apps/web/a.html": "<!-- to-do 1234 -->",
      "apps/web/a.svg": "<!-- to-do 1234 -->",
      "scripts/a.zsh": "# to-do 1234",
    });
    expect(findRetiredTodoCitations(source).map((finding) => finding.file)).toEqual([
      "apps/ios/X.swift",
      "apps/web/a.css",
      "apps/web/a.html",
      "apps/web/a.svg",
      "scripts/a.zsh",
    ]);
  });

  test("a live to-do, or one marked retired beside it, passes", () => {
    const findings = findRetiredTodoCitations(
      index({
        ...LIVE,
        "apps/a.ts": [
          "// on the checklist (to-do 7568).",
          "// a bound (to-do 0019 (retired) task 5).",
          "// from retired to-do 1250, a live check.",
          "// to-dos 8101 and 8093, retired) and still",
          "// done by #2149, no number left.",
        ].join("\n"),
      }),
    );
    expect(findings).toEqual([]);
  });

  test("documentation, plans, generated code, data files and other file types are not read", () => {
    const findings = findRetiredTodoCitations(
      index({
        ...LIVE,
        "docs/architecture/x.ts": "// to-do 1202\n",
        "plans/unified/y.ts": "// to-do 1202\n",
        "README.md": "to-do 1202\n",
        "bridges/codex-bridge/src/app-server/generated/z.ts": "// to-do 1202\n",
        "e2e/fixture/KeyInformationTabFixture.tsx": '"To-do 1202 task 6"\n',
        "apps/web/public/w.png": "to-do 1202",
        "apps/gone.ts": null,
      }),
    );
    expect(findings).toEqual([]);
  });

  test("a container file and a Dockerfile are read", () => {
    const findings = findRetiredTodoCitations(
      index({
        ...LIVE,
        "docker/Dockerfile": "# pinned for to-do 0405\n",
        "docker/entrypoint.pl": "# to-do 0405\n",
      }),
    );
    expect(findings.map((finding) => finding.file)).toEqual([
      "docker/Dockerfile",
      "docker/entrypoint.pl",
    ]);
  });

  test("each problem names the file, line and citation", () => {
    expect(
      checkRetiredTodoCitations(index({ ...LIVE, "apps/a.ts": "\n\n// Todo 7840: hints.\n" })),
    ).toEqual(['apps/a.ts:3 cites "Todo 7840", which has no file under docs/todo/']);
  });
});
