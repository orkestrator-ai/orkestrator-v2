import { describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import {
  __testing as normalizationTesting,
  capCommandOutput,
  countDiffLines,
  getFileChangeDiffMetadata,
  hasVisibleText,
  itemToParts,
  readGitHeadTextFile,
  runGitDiffNoIndex,
} from "./normalization.js";
import { BaselineMap } from "./diff-budget.js";

async function withIsolatedTempDir<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "normalization-test-"));
  const previousTempDir = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    expect(tmpdir()).toBe(directory);
    return await callback(directory);
  } finally {
    if (previousTempDir === undefined) {
      delete process.env.TMPDIR;
    } else {
      process.env.TMPDIR = previousTempDir;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

describe("reasoning normalization", () => {
  test("drops text made only of whitespace and default-ignorable code points", async () => {
    for (const text of [
      "",
      " \n\t",
      "\u0085",
      "\u00a0",
      "\u200b",
      "\u2060",
      "\uFEFF",
      "\uFE0F",
      " \u200b\u2060\n",
    ]) {
      expect(await itemToParts({
        id: "reasoning",
        type: "reasoning",
        text,
      }, "/tmp")).toEqual([]);
    }
  });

  test("preserves non-empty thinking content byte-for-byte", async () => {
    const content = "  Inspecting the workspace.\n";
    expect(await itemToParts({
      id: "reasoning",
      type: "reasoning",
      text: content,
    }, "/tmp")).toEqual([{ type: "thinking", content }]);
  });

  test("preserves meaningful emoji containing default-ignorable joiners", async () => {
    const content = " \u{1F469}\u200D\u{1F4BB}\uFE0F ";
    expect(await itemToParts({
      id: "reasoning",
      type: "reasoning",
      text: content,
    }, "/tmp")).toEqual([{ type: "thinking", content }]);
  });
});

describe("diff line counting", () => {
  test("counts header-shaped lines only when they occur inside a hunk", () => {
    const diff = [
      "diff --git a/example.txt b/example.txt",
      "--- a/example.txt",
      "+++ b/example.txt",
      "@@ -1,3 +1,3 @@",
      "--- value",
      "+++ value",
      "-ordinary deletion",
      "+ordinary addition",
    ].join("\n");

    expect(countDiffLines(diff)).toEqual({ additions: 2, deletions: 2 });
  });

  test("resets hunk state at each file boundary", () => {
    const diff = [
      "diff --git a/first.txt b/first.txt",
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "--- value",
      "+++ value",
      "diff --git a/second.txt b/second.txt",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "---- value",
      "++++ value",
    ].join("\n");

    expect(countDiffLines(diff)).toEqual({
      additions: 2,
      deletions: 2,
    });
  });
});

describe("git diff fallbacks", () => {
  test("returns undefined when git cannot read HEAD content", async () => {
    expect(
      await readGitHeadTextFile("/path/that/does/not/exist", "missing.txt"),
    ).toBeUndefined();
  });

  test("returns undefined when git HEAD output exceeds the read cap", async () => {
    await withIsolatedTempDir(async (directory) => {
      execFileSync("git", ["init"], { cwd: directory, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: directory,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Test User"], {
        cwd: directory,
        stdio: "ignore",
      });
      await writeFile(
        join(directory, "oversized.txt"),
        "x".repeat(2 * 1024 * 1024 + 1),
        "utf8",
      );
      execFileSync("git", ["add", "oversized.txt"], { cwd: directory, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "oversized"], {
        cwd: directory,
        stdio: "ignore",
      });

      expect(await readGitHeadTextFile(directory, "oversized.txt")).toBeUndefined();
    });
  });

  test("returns undefined without creating temp files for equal content", async () => {
    await withIsolatedTempDir(async (directory) => {
      expect(await runGitDiffNoIndex("/tmp", "same.txt", "same\n", "same\n"))
        .toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("cleans its temp directory when git execution fails without stdout", async () => {
    await withIsolatedTempDir(async (directory) => {
      expect(
        await runGitDiffNoIndex(
          "/path/that/does/not/exist",
          "failed.txt",
          "before\n",
          "after\n",
        ),
      ).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("cleans its temp directory when writing a diff input fails", async () => {
    const removeTempDir = mock(async () => undefined);
    const execute = mock(async () => ({ stdout: "" }));
    const writeTextFile = mock(async () => {
      throw new Error("simulated write failure");
    });

    await expect(normalizationTesting.runGitDiffNoIndexWithIo(
      "/tmp",
      "unwritable.txt",
      "before\n",
      "after\n",
      {
        makeTempDir: async () => "/tmp/normalization-write-failure",
        writeTextFile,
        removeTempDir,
        execute,
      },
    )).rejects.toThrow("simulated write failure");
    expect(writeTextFile).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(removeTempDir).toHaveBeenCalledTimes(1);
    expect(removeTempDir).toHaveBeenCalledWith("/tmp/normalization-write-failure");
  });

  test("discards partial oversized diff output and still removes temporary inputs", async () => {
    await withIsolatedTempDir(async (directory) => {
      const oversized = "x".repeat(2 * 1024 * 1024 + 1);
      const diff = await runGitDiffNoIndex("/tmp", "oversized.txt", "", oversized);

      expect(diff).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    });
  });
});

describe("hasVisibleText", () => {
  test.each([
    ["an empty string", ""],
    ["ascii whitespace", " \n\t\r"],
    ["a next-line control", ""],
    ["a byte-order mark", "﻿"],
    ["a zero-width joiner", "‍"],
    ["a soft hyphen", "­"],
    ["mixed invisibles", "﻿ ​\n"],
  ])("treats %s as invisible", (_label, value) => {
    expect(hasVisibleText(value)).toBe(false);
  });

  test.each([
    ["ordinary text", "hello"],
    ["a lone punctuation mark", "."],
    ["an emoji", "🙂"],
    ["text padded with invisibles", "﻿ hi ​"],
    ["a non-breaking space with content", " x"],
  ])("treats %s as visible", (_label, value) => {
    expect(hasVisibleText(value)).toBe(true);
  });

  test("a non-breaking space alone is whitespace, not content", () => {
    // `\p{White_Space}` includes U+00A0, so an "empty" reasoning summary made of
    // them must not render as a blank bubble.
    expect(hasVisibleText("  ")).toBe(false);
  });
});

describe("getFileChangeDiffMetadata", () => {
  test("prefers a retained baseline over git HEAD for the before content", async () => {
    await withIsolatedTempDir(async () => {
      const context = {
        baselines: new BaselineMap([["tracked.txt", "from-baseline\n"]]),
        cache: new Map(),
      };
      const metadata = await getFileChangeDiffMetadata(
        "/path/that/does/not/exist",
        { path: "tracked.txt", kind: "update" },
        context,
      );

      // A baseline is what makes a second edit diff against the previous turn
      // rather than against HEAD, so it must win even when HEAD is readable.
      expect(metadata.before).toBe("from-baseline\n");
      expect(metadata.filePath).toBe("/path/that/does/not/exist/tracked.txt");
    });
  });

  test("returns a cache hit verbatim without re-running git", async () => {
    const cached = { filePath: "/cached.ts", diff: "cached diff" };
    const metadata = await getFileChangeDiffMetadata(
      "/path/that/does/not/exist",
      { path: "cached.ts", kind: "update" },
      { baselines: new BaselineMap(), cache: new Map([["key", cached]]) },
      "key",
    );

    expect(metadata).toBe(cached);
  });

  test("reports zero counts rather than throwing when git cannot run", async () => {
    await withIsolatedTempDir(async (directory) => {
      const metadata = await getFileChangeDiffMetadata(
        "/path/that/does/not/exist",
        { path: "missing.ts", kind: "update" },
      );

      // Diff detail is additive; a transcript must still render without it.
      expect(metadata).toMatchObject({ additions: 0, deletions: 0 });
      expect(metadata.diff).toBeUndefined();
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("resolves an absolute change path without re-joining it to cwd", async () => {
    await withIsolatedTempDir(async () => {
      const metadata = await getFileChangeDiffMetadata(
        "/path/that/does/not/exist",
        { path: "/tmp/elsewhere/a.ts", kind: "add" },
      );

      expect(metadata.filePath).toBe("/tmp/elsewhere/a.ts");
    });
  });

  test("skips the HEAD read for an added file and the disk read for a deleted one", async () => {
    await withIsolatedTempDir(async () => {
      const added = await getFileChangeDiffMetadata(
        "/path/that/does/not/exist",
        { path: "added.ts", kind: "add" },
      );
      const deleted = await getFileChangeDiffMetadata(
        "/path/that/does/not/exist",
        { path: "deleted.ts", kind: "delete" },
      );

      expect(added.before).toBeUndefined();
      expect(deleted.after).toBeUndefined();
    });
  });
});

describe("command normalization bounds", () => {
  test("caps oversized failed command output without duplicating it", async () => {
    const oversized = "x".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 10);
    const [part] = await itemToParts({
      id: "command",
      type: "command_execution",
      command: "generate",
      aggregated_output: oversized,
      status: "failed",
    }, "/tmp");

    expect(part?.toolOutput).toBeUndefined();
    // The cap is a memory bound, so the truncated result must fit *inside* it —
    // appending the notice must not push it back over.
    expect(part?.toolError?.length).toBeLessThanOrEqual(
      DEFAULT_MAX_COMMAND_OUTPUT_CHARS,
    );
    expect(part?.toolError).toEndWith("… output truncated");
  });

  test("passes output of exactly the cap through untouched", async () => {
    // Boundary for the `<=`: one character either way is silently invisible in
    // the oversized and ordinary cases above.
    const exact = "y".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);
    expect(capCommandOutput(exact)).toBe(exact);
    expect(capCommandOutput(exact).length).toBe(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);

    const [part] = await itemToParts({
      id: "exact",
      type: "command_execution",
      command: "generate",
      aggregated_output: exact,
      status: "completed",
    }, "/tmp");
    expect(part?.toolOutput).toBe(exact);

    expect(capCommandOutput("z".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 1))).not.toBe(
      exact,
    );
  });

  test("never slices from the end when the cap is tighter than the notice", () => {
    // `maxChars - notice.length` goes negative here; an unguarded slice would
    // return the *tail* of the output and grow the result instead of capping it.
    expect(capCommandOutput("abcdefghij", 3)).toBe("\n… output truncated");
    expect(capCommandOutput("abcdefghij", 0)).toBe("\n… output truncated");
  });

  test("keeps ordinary output byte-for-byte and supplies a default failure", async () => {
    expect((await itemToParts({
      id: "ok",
      type: "command_execution",
      command: "echo ok",
      aggregated_output: "ok\n",
      status: "completed",
    }, "/tmp"))[0]?.toolOutput).toBe("ok\n");

    expect((await itemToParts({
      id: "failed",
      type: "command_execution",
      command: "false",
      aggregated_output: "",
      status: "failed",
    }, "/tmp"))[0]?.toolError).toBe("Command failed");
  });
});
