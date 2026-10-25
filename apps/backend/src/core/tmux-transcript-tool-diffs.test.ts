import { describe, expect, test } from "bun:test";
import { transcriptToolDiffs } from "./tmux-transcript-tool-diffs.js";

function toolLine(...blocks: Array<{ id: string; name: string; input: Record<string, unknown> }>) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: blocks.map((block) => ({ type: "tool_use", ...block })),
    },
  };
}

describe("transcriptToolDiffs", () => {
  test("Edit maps to its path and before/after sides, never counts", () => {
    const diffs = transcriptToolDiffs(
      toolLine({
        id: "e",
        name: "Edit",
        input: {
          file_path: "/w/package.json",
          old_string: '"react": "18"',
          new_string: '"react": "19"',
        },
      }),
    );
    expect(diffs?.e).toEqual({
      filePath: "/w/package.json",
      before: '"react": "18"',
      after: '"react": "19"',
    });
  });

  test("write-like tools have an unknown prior state, not an empty file", () => {
    const diffs = transcriptToolDiffs(
      toolLine(
        { id: "w", name: "Write", input: { file_path: "/w/foo.txt", content: "line1\nline2" } },
        { id: "c", name: "create_file", input: { path: "/w/c", content: "" } },
      ),
    );
    expect(diffs?.w).toEqual({ filePath: "/w/foo.txt", after: "line1\nline2" });
    expect(diffs?.c).toEqual({ filePath: "/w/c", after: "" });
  });

  test("MultiEdit joins its chunks without adding blank lines", () => {
    const diffs = transcriptToolDiffs(
      toolLine({
        id: "m",
        name: "MultiEdit",
        input: {
          file_path: "/w/foo.ts",
          edits: [
            { old_string: "one\n", new_string: "two\n" },
            { old_string: "three", new_string: "four" },
          ],
        },
      }),
    );
    expect(diffs?.m).toEqual({ filePath: "/w/foo.ts", before: "one\nthree", after: "two\nfour" });
  });

  test("NotebookEdit keeps the notebook path; delete mode has no content", () => {
    const diffs = transcriptToolDiffs(
      toolLine(
        {
          id: "n",
          name: "NotebookEdit",
          input: { notebook_path: "/w/a.ipynb", new_source: "print('done')" },
        },
        {
          id: "d",
          name: "NotebookEdit",
          input: { notebook_path: "/w/a.ipynb", edit_mode: "delete" },
        },
      ),
    );
    expect(diffs?.n).toMatchObject({ filePath: "/w/a.ipynb", after: "print('done')" });
    expect(diffs?.d).toEqual({ filePath: "/w/a.ipynb" });
  });

  test("an unmapped tool still surfaces its path; lines without tools stay unstamped", () => {
    expect(
      transcriptToolDiffs(toolLine({ id: "r", name: "Read", input: { file_path: "/w/foo.ts" } })),
    ).toEqual({
      r: { filePath: "/w/foo.ts" },
    });
    expect(
      transcriptToolDiffs(toolLine({ id: "b", name: "Bash", input: { command: "ls" } })),
    ).toBeNull();
    expect(transcriptToolDiffs({ type: "user", message: { content: "hello" } })).toBeNull();
  });
});
