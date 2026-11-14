import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { configureLogger, renderLogLine, resetLogger } from "@orkestrator/protocol/logger";
import {
  parsePromptReadsLine,
  promptReadsFromLogs,
  promptReadsInText,
} from "./auto-pipeline-prompt-reads";

const READS = { prompts: 4, instructionReads: 1, notesReads: 1 };

/** The line the backend's logger writes for `reads`, in the given format. */
function rendered(format: "text" | "json", reads = READS): string {
  configureLogger({ format });
  try {
    return renderLogLine("debug", "build-pipeline", "review.prompt-reads", reads);
  } finally {
    resetLogger();
  }
}

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function logDir(files: Record<string, string>): string {
  const directory = mkdtempSync(path.join(tmpdir(), "auto-pipeline-prompt-reads-"));
  directories.push(directory);
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(directory, name), text);
  return directory;
}

describe("auto-pipeline prompt-reads parsing", () => {
  test.each(["text", "json"] as const)("reads the logger's %s rendering", (format) => {
    const line = rendered(format);
    expect(parsePromptReadsLine(line)).toEqual(READS);
    // Whatever the writing process puts in front of the record.
    expect(parsePromptReadsLine(`2026-11-14T02:00:00.000Z [backend] ${line}`)).toEqual(READS);
  });

  test("reads a failed build's pass with no prompts and multi-digit counts", () => {
    const failed = { prompts: 0, instructionReads: 2, notesReads: 12 };
    expect(parsePromptReadsLine(rendered("text", failed))).toEqual(failed);
    expect(parsePromptReadsLine(rendered("json", failed))).toEqual(failed);
  });

  test("ignores other build-pipeline lines", () => {
    configureLogger({ format: "text" });
    try {
      const other = renderLogLine("info", "build-pipeline", "result.consume-deferred");
      expect(parsePromptReadsLine(other)).toBeNull();
    } finally {
      resetLogger();
    }
    expect(parsePromptReadsLine("review.prompt-reads with no counts")).toBeNull();
    expect(parsePromptReadsLine("")).toBeNull();
  });

  test("collects every pass in a log, in order", () => {
    const second = { prompts: 1, instructionReads: 1, notesReads: 1 };
    const text = ["noise", rendered("text"), "more noise", rendered("text", second), ""].join("\n");
    expect(promptReadsInText(text)).toEqual([READS, second]);
  });

  test("counts the log file with the most lines rather than summing relay copies", () => {
    const backend = [rendered("json"), rendered("json")].join("\n");
    const directory = logDir({
      "backend.log": backend,
      "electron.log": [rendered("text"), rendered("text"), rendered("text")].join("\n"),
      "launcher.log": rendered("text"),
      // Not a log file, whatever it holds.
      "prompt-reads.json": Array(5).fill(rendered("json")).join("\n"),
    });
    expect(promptReadsFromLogs(directory)).toEqual({
      file: "electron.log",
      passes: [READS, READS, READS],
    });
  });

  test("picks the first file by name on a tie and reports none when no line exists", () => {
    expect(
      promptReadsFromLogs(logDir({ "b.log": rendered("text"), "a.log": rendered("json") })),
    ).toEqual({ file: "a.log", passes: [READS] });
    expect(promptReadsFromLogs(logDir({ "electron.log": "nothing here\n" }))).toEqual({
      file: null,
      passes: [],
    });
  });
});
