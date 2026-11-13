/**
 * The engine parts run in separate `bun test --parallel` workers and each merges
 * its own results into one `ARTIFACT_ENGINE_REPORT` file. These tests start real
 * concurrent writer processes, released together, and check no part's results
 * are lost.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  mergeEngineReports,
  mergeIntoEngineReport,
  type EngineReport,
} from "./content-server.engines-report-test-support.js";

const MODULE = path.join(import.meta.dir, "content-server.engines-report-test-support.ts");

/** One writer: signals it is ready, waits for the shared go file, then merges its part. */
const WRITER = `
import { existsSync, writeFileSync } from "node:fs";
import { mergeIntoEngineReport } from ${JSON.stringify(MODULE)};
const [reportFile, readyFile, goFile, additions] = process.argv.slice(2);
writeFileSync(readyFile, "");
while (!existsSync(goFile)) await Bun.sleep(1);
await mergeIntoEngineReport(reportFile, JSON.parse(additions));
`;

let directory = "";

afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
  directory = "";
});

async function waitForFiles(files: readonly string[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!files.every((file) => existsSync(file))) {
    if (Date.now() > deadline) throw new Error("writers did not start");
    await Bun.sleep(5);
  }
}

/** Runs one writer process per entry of `parts`, released at the same moment. */
async function runConcurrentWriters(reportFile: string, parts: EngineReport[]): Promise<void> {
  const script = path.join(directory, "writer.ts");
  writeFileSync(script, WRITER);
  const goFile = path.join(directory, "go");
  const readyFiles = parts.map((_, index) => path.join(directory, `ready-${index}`));
  const writers = parts.map((additions, index) =>
    Bun.spawn(
      [process.execPath, script, reportFile, readyFiles[index]!, goFile, JSON.stringify(additions)],
      { stdout: "ignore", stderr: "pipe" },
    ),
  );
  try {
    await waitForFiles(readyFiles, 20_000);
    writeFileSync(goFile, "");
    const codes = await Promise.all(writers.map((writer) => writer.exited));
    const errors = await Promise.all(writers.map((writer) => new Response(writer.stderr).text()));
    expect({ codes, errors: errors.filter(Boolean) }).toEqual({
      codes: parts.map(() => 0),
      errors: [],
    });
  } finally {
    for (const writer of writers) if (writer.exitCode === null) writer.kill();
  }
}

describe("engine qualification report", () => {
  test("merges fields within an engine and keeps other engines", () => {
    expect(
      mergeEngineReports(
        { chromium: { version: "1", lanes: 1 }, firefox: { version: "2" } },
        { chromium: { csp: "pass" }, webkit: { version: "3" } },
      ),
    ).toEqual({
      chromium: { version: "1", lanes: 1, csp: "pass" },
      firefox: { version: "2" },
      webkit: { version: "3" },
    });
  });

  test("concurrent writers keep every part's fields, within one engine and across engines", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "engine-report-"));
    const reportFile = path.join(directory, "report.json");
    writeFileSync(reportFile, JSON.stringify({ chromium: { version: "prior" } }));
    // Nine parts, as the engine suite has: three lanes for each of three engines, plus one
    // field per part on a shared engine so every writer touches the same entry.
    const parts: EngineReport[] = Array.from({ length: 9 }, (_, index) => ({
      [`engine-${Math.floor(index / 3)}`]: { [`lane-${index % 3}`]: index },
      chromium: { [`part-${index}`]: true },
    }));
    await runConcurrentWriters(reportFile, parts);

    const final = JSON.parse(readFileSync(reportFile, "utf8")) as EngineReport;
    expect(final).toEqual({
      chromium: {
        version: "prior",
        ...Object.fromEntries(parts.map((_, index) => [`part-${index}`, true])),
      },
      "engine-0": { "lane-0": 0, "lane-1": 1, "lane-2": 2 },
      "engine-1": { "lane-0": 3, "lane-1": 4, "lane-2": 5 },
      "engine-2": { "lane-0": 6, "lane-1": 7, "lane-2": 8 },
    });
    // The lock and every temporary file are gone.
    expect(
      [...new Bun.Glob("*").scanSync(directory)].filter((name) => /\.(?:lock|tmp)$/.test(name)),
    ).toEqual([]);
  }, 60_000);

  test("refuses to overwrite a report it cannot parse", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "engine-report-"));
    const reportFile = path.join(directory, "report.json");
    writeFileSync(reportFile, "{ not json");
    await expect(mergeIntoEngineReport(reportFile, { webkit: { version: "1" } })).rejects.toThrow();
    expect(readFileSync(reportFile, "utf8")).toBe("{ not json");
    expect(existsSync(`${reportFile}.lock`)).toBe(false);
  });
});
