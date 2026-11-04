import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { networkChurnReport } from "./network-churn-report";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((target) => rm(target, { recursive: true, force: true })),
  );
});

async function artifacts(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ork-network-churn-"));
  temporaryDirectories.push(root);
  return root;
}

async function failedCase(root: string, name: string, files: Record<string, string>) {
  const directory = path.join(root, name);
  await mkdir(directory);
  for (const [file, content] of Object.entries(files)) {
    await writeFile(path.join(directory, file), content);
  }
  const zipped = spawnSync("zip", ["-q", "trace.zip", ...Object.keys(files)], { cwd: directory });
  expect(zipped.status).toBe(0);
}

const aborted = 'console {"text":"Failed to load resource: net::ERR_NETWORK_CHANGED"}\n';

describe("networkChurnReport", () => {
  test("names only the cases whose trace holds the abort, with a count across trace files", async () => {
    const root = await artifacts();
    await failedCase(root, "case-churned", {
      "0-trace.trace": aborted.repeat(2),
      "test.trace": aborted,
    });
    await failedCase(root, "case-real-failure", { "0-trace.trace": "console ok\n" });

    const report = networkChurnReport(root);

    expect(report).toContain("1 failed case(s)");
    expect(report).toContain("case-churned: 3");
    expect(report).not.toContain("case-real-failure");
  });

  test("ignores the abort outside a trace file", async () => {
    const root = await artifacts();
    await failedCase(root, "case-network-log", { "0-trace.network": aborted });
    expect(networkChurnReport(root)).toBeNull();
  });

  test("is silent with no failed cases, no artifacts or a missing archive", async () => {
    const root = await artifacts();
    expect(networkChurnReport(root)).toBeNull();
    expect(networkChurnReport(path.join(root, "missing"))).toBeNull();
    await mkdir(path.join(root, "case-no-trace"));
    await writeFile(path.join(root, ".last-run.json"), "{}");
    expect(networkChurnReport(root)).toBeNull();
  });
});

test("ignores corrupt archives while reporting readable neighbors", async () => {
  const root = await artifacts();
  await mkdir(path.join(root, "corrupt"));
  await writeFile(path.join(root, "corrupt", "trace.zip"), "not a zip");
  await failedCase(root, "valid", { "test.trace": aborted });
  expect(networkChurnReport(root)).toContain("valid: 1");
  expect(networkChurnReport(root)).not.toContain("corrupt:");
});
test("discards partial unzip output when it exceeds the byte bound", async () => {
  const root = await artifacts();
  await failedCase(root, "oversized", { "test.trace": aborted.repeat(100_000) });
  expect(networkChurnReport(root, 1024)).toBeNull();
  expect(networkChurnReport(root)).toContain("oversized: 100000");
});
