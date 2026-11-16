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
