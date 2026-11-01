import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectBugReportMachineFacts } from "./bug-report-facts.js";

test("bug reports discover text and JSON logs, including numbered rolls", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "orkestrator-log-facts-"));
  try {
    const logsDir = path.join(dataDir, "logs");
    await mkdir(logsDir);
    const names = [
      "orkestrator-ai-2026-11-01.log",
      "orkestrator-ai-2026-11-01.jsonl",
      "orkestrator-backend-2026-11-01.1.jsonl",
    ];
    for (const [index, name] of names.entries()) {
      const file = path.join(logsDir, name);
      await writeFile(file, "entry\n");
      const time = new Date(Date.UTC(2026, 10, 1, 12, index));
      await utimes(file, time, time);
    }
    await writeFile(path.join(logsDir, "unrelated.json"), "{}");
    await mkdir(path.join(logsDir, "directory.jsonl"));
    const facts = await collectBugReportMachineFacts({
      dataDir,
      toolchainBinDir: path.join(dataDir, "bin"),
      toolchainRoot: path.join(dataDir, "toolchains"),
    });
    expect(facts.recentLogs.map((file) => file.name)).toEqual(names.toReversed());
    expect(facts.recentLogs.every((file) => file.bytes === 6)).toBe(true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
