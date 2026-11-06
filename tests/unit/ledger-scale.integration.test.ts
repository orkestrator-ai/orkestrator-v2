import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Delays only the operation under test, without depending on the host's load. */
const preload = `
import { Database } from "bun:sqlite";
const delay = (ms) => { const end = performance.now() + ms; while (performance.now() < end) {} };
if (process.env.LEDGER_TEST_PHASE === "manifest") {
  const stringify = JSON.stringify;
  JSON.stringify = function(value, ...args) {
    if (value?.v === 1 && String(value.root).startsWith("bench-")) delay(Number(process.env.LEDGER_TEST_DELAY_MS));
    return stringify.call(this, value, ...args);
  };
} else {
  const query = Database.prototype.query;
  Database.prototype.query = function(sql, ...args) {
    const statement = query.call(this, sql, ...args);
    if (sql.includes("SELECT MAX(ingested_seq) AS seq FROM change_evidence")) {
      const get = statement.get.bind(statement);
      statement.get = (...params) => { delay(15); return get(...params); };
    }
    return statement;
  };
}
`;

interface Phase {
  phase: string;
  maxStallMs: number;
  over100Ms: number;
  over1s: number;
  stringifyStallMs: number;
  retiredRows: number;
}
interface Report {
  phases: Phase[];
  slowPlans: Array<{ sql: string; calls: number; maxMs: number }>;
}

function benchmark(phase: string, delayMs = 150): Report {
  const directory = mkdtempSync(join(tmpdir(), "ork-ledger-report-test-"));
  try {
    const hook = join(directory, "delay.ts");
    const report = join(directory, "report.json");
    writeFileSync(hook, preload);
    execFileSync(
      process.execPath,
      [
        "--preload",
        hook,
        resolve(import.meta.dir, "../../scripts/efficiency/ledger-scale.ts"),
        "--scale",
        "0",
        "--agents",
        "0",
        "--seconds",
        "0",
        "--manifest-entries",
        "10",
        "--only",
        phase,
        "--out",
        report,
      ],
      {
        env: { ...process.env, LEDGER_TEST_PHASE: phase, LEDGER_TEST_DELAY_MS: String(delayMs) },
        timeout: 55_000,
        maxBuffer: 512 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return JSON.parse(readFileSync(report, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test.each([150, 1100])(
  "a %d ms manifest stall remains in the phase maximum and buckets",
  (delayMs) => {
    const report = benchmark("manifest", delayMs);
    expect(report.phases).toHaveLength(1);
    const phase = report.phases[0]!;
    expect(phase.phase).toBe("manifest");
    const threshold = delayMs >= 1000 ? 1000 : 100;
    expect(phase.stringifyStallMs).toBeGreaterThanOrEqual(threshold);
    expect(phase.maxStallMs).toBeGreaterThanOrEqual(threshold);
    expect(phase.over100Ms).toBeGreaterThanOrEqual(1);
    if (delayMs >= 1000) expect(phase.over1s).toBeGreaterThanOrEqual(1);
  },
  60_000,
);

test("window-only plans include retirement statements and their window-phase peak", () => {
  const report = benchmark("window");
  expect(report.phases).toHaveLength(1);
  expect(report.phases[0]!.phase).toBe("window");
  expect(report.phases[0]!.retiredRows).toBeGreaterThan(0);
  const plan = report.slowPlans.find((entry) =>
    entry.sql.includes("SELECT MAX(ingested_seq) AS seq FROM change_evidence"),
  );
  expect(plan).toBeDefined();
  expect(plan!.calls).toBeGreaterThan(0);
  expect(plan!.maxMs).toBeGreaterThanOrEqual(15);
}, 60_000);
