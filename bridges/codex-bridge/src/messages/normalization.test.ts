import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_COMMAND_OUTPUT_CHARS } from "../sessions/turn-accumulator.js";
import {
  capCommandOutput,
  countDiffLines,
  fileChangeDiffMetadata,
  getFileChangeDiffMetadata,
  hasVisibleText,
  itemToParts,
} from "./normalization.js";

async function withIsolatedTempDir<T>(callback: (directory: string) => Promise<T>): Promise<T> {
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

describe("agent-message normalization", () => {
  test("unwraps schema-shaped commentary into readable progress", async () => {
    expect(
      await itemToParts(
        {
          id: "commentary",
          type: "agent_message",
          phase: "commentary",
          text: JSON.stringify({
            validation: [],
            uncommittedFiles: [],
            reviewScope: { limitations: ["Tracing the missing transcript updates."] },
          }),
        },
        "/tmp",
      ),
    ).toEqual([{ type: "text", content: "Tracing the missing transcript updates." }]);
  });

  test("unwraps verification and structured-review commentary fields", async () => {
    expect(
      await itemToParts(
        {
          id: "verification",
          type: "agent_message",
          phase: "commentary",
          text: '{"complete":false,"rationale":"Still checking the validation results."}',
        },
        "/tmp",
      ),
    ).toEqual([{ type: "text", content: "Still checking the validation results." }]);

    expect(
      await itemToParts(
        {
          id: "review",
          type: "agent_message",
          phase: "commentary",
          text: '{"reviewSummary":"Inspecting the changed bridge paths."}',
        },
        "/tmp",
      ),
    ).toEqual([{ type: "text", content: "Inspecting the changed bridge paths." }]);
  });

  test("leaves prose and unrecognized or streaming machine output unchanged", async () => {
    const prose = "Checking the transcript now.";
    expect(
      await itemToParts(
        { id: "prose", type: "agent_message", phase: "commentary", text: prose },
        "/tmp",
      ),
    ).toEqual([{ type: "text", content: prose }]);

    for (const text of ['{"status":"checking"}', '{"reviewSummary":"still checking"']) {
      expect(
        await itemToParts(
          {
            id: "fallback",
            type: "agent_message",
            phase: "commentary",
            text,
          },
          "/tmp",
        ),
      ).toEqual([{ type: "text", content: text }]);
    }
  });
});

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
      expect(
        await itemToParts(
          {
            id: "reasoning",
            type: "reasoning",
            text,
          },
          "/tmp",
        ),
      ).toEqual([]);
    }
  });

  test("preserves non-empty thinking content byte-for-byte", async () => {
    const content = "  Inspecting the workspace.\n";
    expect(
      await itemToParts(
        {
          id: "reasoning",
          type: "reasoning",
          text: content,
        },
        "/tmp",
      ),
    ).toEqual([{ type: "thinking", content }]);
  });

  test("preserves meaningful emoji containing default-ignorable joiners", async () => {
    const content = " \u{1F469}\u200D\u{1F4BB}\uFE0F ";
    expect(
      await itemToParts(
        {
          id: "reasoning",
          type: "reasoning",
          text: content,
        },
        "/tmp",
      ),
    ).toEqual([{ type: "thinking", content }]);
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
  test("returns a cache hit verbatim", async () => {
    const cached = { filePath: "/cached.ts", diff: "cached diff" };
    const metadata = await getFileChangeDiffMetadata(
      "/path/that/does/not/exist",
      { path: "cached.ts", kind: "update", diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { cache: new Map([["key", cached]]) },
      "key",
    );

    expect(metadata).toBe(cached);
  });

  test("leaves the counts unknown when no diff was supplied, touching nothing on disk", async () => {
    await withIsolatedTempDir(async (directory) => {
      const metadata = await getFileChangeDiffMetadata("/path/that/does/not/exist", {
        path: "missing.ts",
        kind: "update",
      });

      expect(metadata).toEqual({ filePath: "/path/that/does/not/exist/missing.ts" });
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("resolves an absolute change path without re-joining it to cwd", async () => {
    const metadata = await getFileChangeDiffMetadata("/path/that/does/not/exist", {
      path: "/tmp/elsewhere/a.ts",
      kind: "add",
      diff: "a\n",
    });

    expect(metadata.filePath).toBe("/tmp/elsewhere/a.ts");
    expect(metadata).toMatchObject({ additions: 1, deletions: 0 });
  });

  test("keeps an update payload that is not unified diff without inventing counts", () => {
    const metadata = fileChangeDiffMetadata(
      "/w",
      { path: "a.ts", kind: "update", diff: "not a diff" },
      "completed",
    );

    expect(metadata).toEqual({ filePath: "/w/a.ts" });
  });
});

describe("command normalization bounds", () => {
  test("caps oversized failed command output without duplicating it", async () => {
    const oversized = "x".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 10);
    const [part] = await itemToParts(
      {
        id: "command",
        type: "command_execution",
        command: "generate",
        aggregated_output: oversized,
        status: "failed",
      },
      "/tmp",
    );

    expect(part?.toolOutput).toBeUndefined();
    // The cap is a memory bound, so the truncated result must fit *inside* it —
    // appending the notice must not push it back over.
    expect(part?.toolError?.length).toBeLessThanOrEqual(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);
    expect(part?.toolError).toEndWith("… output truncated");
  });

  test("passes output of exactly the cap through untouched", async () => {
    // Boundary for the `<=`: one character either way is silently invisible in
    // the oversized and ordinary cases above.
    const exact = "y".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);
    expect(capCommandOutput(exact)).toBe(exact);
    expect(capCommandOutput(exact).length).toBe(DEFAULT_MAX_COMMAND_OUTPUT_CHARS);

    const [part] = await itemToParts(
      {
        id: "exact",
        type: "command_execution",
        command: "generate",
        aggregated_output: exact,
        status: "completed",
      },
      "/tmp",
    );
    expect(part?.toolOutput).toBe(exact);

    expect(capCommandOutput("z".repeat(DEFAULT_MAX_COMMAND_OUTPUT_CHARS + 1))).not.toBe(exact);
  });

  test("never slices from the end when the cap is tighter than the notice", () => {
    // `maxChars - notice.length` goes negative here; an unguarded slice would
    // return the *tail* of the output and grow the result instead of capping it.
    expect(capCommandOutput("abcdefghij", 3)).toBe("\n… output truncated");
    expect(capCommandOutput("abcdefghij", 0)).toBe("\n… output truncated");
  });

  test("keeps ordinary output byte-for-byte and supplies a default failure", async () => {
    expect(
      (
        await itemToParts(
          {
            id: "ok",
            type: "command_execution",
            command: "echo ok",
            aggregated_output: "ok\n",
            status: "completed",
          },
          "/tmp",
        )
      )[0]?.toolOutput,
    ).toBe("ok\n");

    expect(
      (
        await itemToParts(
          {
            id: "failed",
            type: "command_execution",
            command: "false",
            aggregated_output: "",
            status: "failed",
          },
          "/tmp",
        )
      )[0]?.toolError,
    ).toBe("Command failed");
  });
});

describe("tool durations", () => {
  test("a finished call carries app-server's own duration", async () => {
    const [command] = await itemToParts(
      {
        id: "cmd",
        type: "command_execution",
        command: "ls",
        aggregated_output: "",
        status: "failed",
        duration_ms: 1_250,
      },
      "/tmp",
    );
    expect(command).toMatchObject({ toolState: "failure", toolDurationMs: 1_250 });

    const [mcp] = await itemToParts(
      {
        id: "mcp",
        type: "mcp_tool_call",
        server: "s",
        tool: "t",
        arguments: {},
        status: "completed",
        duration_ms: 30,
      },
      "/tmp",
    );
    expect(mcp).toMatchObject({ toolState: "success", toolDurationMs: 30 });

    const [dynamic] = await itemToParts(
      {
        id: "dyn",
        type: "dynamic_tool_call",
        tool: "lookup",
        arguments: {},
        content_items: [],
        status: "completed",
        duration_ms: 0,
      },
      "/tmp",
    );
    expect(dynamic).toMatchObject({ toolDurationMs: 0 });
  });

  test("a running call never carries a duration, even if one was reported", async () => {
    const [command] = await itemToParts(
      {
        id: "cmd",
        type: "command_execution",
        command: "sleep 5",
        aggregated_output: "",
        status: "in_progress",
        duration_ms: 1_000,
      },
      "/tmp",
    );
    expect(command).toMatchObject({ toolState: "pending" });
    expect(command).not.toHaveProperty("toolDurationMs");
  });

  test("an unknown duration is omitted rather than reported as zero", async () => {
    const [command] = await itemToParts(
      {
        id: "cmd",
        type: "command_execution",
        command: "ls",
        aggregated_output: "",
        status: "completed",
      },
      "/tmp",
    );
    expect(command).not.toHaveProperty("toolDurationMs");
  });
});
