import { describe, expect, test } from "bun:test";
import { parseBundleFiles, type BundleData } from "./bundle.js";
import { compareVersions, extractSignals, scoreSignal, type Signal } from "./signals.js";
import { bundleFiles, DAY, type FixtureBundle, healthRun, HOUR } from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");

function load(bundle: FixtureBundle): BundleData {
  const files = new Map(bundleFiles(bundle).map((file) => [file.name, Buffer.from(file.contents)]));
  return parseBundleFiles(files, "0".repeat(64));
}

function signal(signals: readonly Signal[], signature: string): Signal {
  const found = signals.find((candidate) => candidate.signature === signature);
  if (!found)
    throw new Error(
      `No ${signature} in ${signals.map((candidate) => candidate.signature).join(", ")}`,
    );
  return found;
}

describe("essential log signals", () => {
  test("groups by area, event, provider and failure kind, and drops per-environment ids", () => {
    const { signals } = extractSignals(
      load({
        createdAt: NOW,
        essential: [
          {
            at: NOW - 2 * DAY,
            area: "local-server",
            event: "bridge.exited",
            fields: { key: "codex:6e0a6a7e", signal: "SIGKILL", requested: false, pid: 1 },
          },
          {
            at: NOW - DAY,
            area: "local-server",
            event: "bridge.exited",
            fields: { key: "codex:aaaa1111", signal: "SIGKILL", requested: false, pid: 2 },
          },
          {
            at: NOW - DAY,
            area: "local-server",
            event: "bridge.exited",
            fields: { key: "claude:aaaa1111", code: 1, requested: false },
          },
          {
            at: NOW - HOUR,
            level: "info",
            area: "local-server",
            event: "bridge.exited",
            fields: { key: "codex:1", requested: true },
          },
          {
            at: NOW - HOUR,
            level: "error",
            area: "storage",
            event: "snapshot.failed",
            fields: { "error.code": "ENOSPC" },
          },
        ],
      }),
    );
    const killed = signal(signals, "local-server:bridge.exited:codex:SIGKILL");
    expect(killed.count).toBe(2);
    expect(killed.activeDays).toBe(2);
    // An unrequested bridge exit ends an agent session, so it ranks as an error.
    expect(killed.category).toBe("error");
    expect(signal(signals, "local-server:bridge.exited:claude:code-1").count).toBe(1);
    expect(signal(signals, "storage:snapshot.failed:ENOSPC").category).toBe("error");
    // An `info` line (a requested stop) is not an issue.
    expect(
      signals.filter((candidate) => candidate.signature.startsWith("local-server")).length,
    ).toBe(2);
  });

  test("merges a throttled site's first line with its suppressed repeats and recoveries", () => {
    const { signals } = extractSignals(
      load({
        createdAt: NOW,
        essential: [
          {
            at: NOW - 3 * HOUR,
            level: "error",
            area: "tmux",
            event: "poll.snapshot-failed",
            fields: { kind: "EACCES" },
          },
          {
            at: NOW - 2 * HOUR,
            level: "error",
            area: "tmux",
            event: "throttle.suppressed",
            fields: { site: "poll.snapshot-failed", kind: "EACCES", suppressed: 240 },
          },
          {
            at: NOW - HOUR,
            level: "error",
            area: "tmux",
            event: "throttle.recovered",
            fields: { site: "poll.snapshot-failed", faultSeconds: 63, failures: 251 },
          },
        ],
      }),
    );
    const fault = signal(signals, "tmux:poll.snapshot-failed:EACCES");
    expect(fault.count).toBe(241);
    // The first line was an error; its throttled repeats stay one error signature.
    expect(fault.category).toBe("error");
    expect(fault.evidence.faultSeconds).toBe(63);
    expect(fault.evidence.recoveries).toBe(1);
  });

  test("weights renderer failures by their reported count and keys them by fingerprint", () => {
    const { signals } = extractSignals(
      load({
        createdAt: NOW,
        essential: [
          {
            at: NOW - HOUR,
            level: "warn",
            area: "renderer-errors",
            event: "error.recorded",
            fields: {
              errorClass: "TypeError",
              boundary: "transcript",
              route: "/env/1",
              fingerprint: "0badf00d",
              count: 7,
            },
          },
          {
            at: NOW - 1000,
            level: "warn",
            area: "renderer-errors",
            event: "error.recorded",
            fields: {
              errorClass: "TypeError",
              boundary: "transcript",
              route: "/env/2",
              fingerprint: "0badf00d",
              count: 3,
            },
          },
        ],
      }),
    );
    expect(signal(signals, "renderer-errors:TypeError:transcript:0badf00d").count).toBe(10);
  });

  test("reports a writer that started again without stopping, and ignores orderly restarts", () => {
    const { signals } = extractSignals(
      load({
        createdAt: NOW,
        essential: [
          {
            at: NOW - 5 * HOUR,
            level: "info",
            area: "logging",
            event: "essential.started",
            fields: { owner: "desktop" },
          },
          {
            at: NOW - 4 * HOUR,
            level: "info",
            area: "logging",
            event: "essential.stopped",
            fields: { owner: "desktop" },
          },
          {
            at: NOW - 3 * HOUR,
            level: "info",
            area: "logging",
            event: "essential.started",
            fields: { owner: "desktop" },
          },
          {
            at: NOW - 2 * HOUR,
            level: "info",
            area: "logging",
            event: "essential.started",
            fields: { owner: "desktop" },
          },
        ],
      }),
    );
    const died = signal(signals, "logging:writer-died:desktop");
    expect(died.count).toBe(1);
    expect(died.category).toBe("crash");
  });

  test("attributes each occurrence to the app version that was running", () => {
    const { signals, observedHours } = extractSignals(
      load({
        createdAt: NOW,
        appVersion: "2.31.0",
        essential: [
          {
            at: NOW - 48 * HOUR,
            level: "info",
            area: "backend",
            event: "starting",
            fields: { version: "2.30.0" },
          },
          {
            at: NOW - 40 * HOUR,
            level: "error",
            area: "storage",
            event: "snapshot.failed",
            fields: { "error.code": "EIO" },
          },
          {
            at: NOW - 24 * HOUR,
            level: "info",
            area: "backend",
            event: "starting",
            fields: { version: "2.31.0" },
          },
          {
            at: NOW - 2 * HOUR,
            level: "error",
            area: "storage",
            event: "snapshot.failed",
            fields: { "error.code": "EIO" },
          },
        ],
      }),
    );
    expect(signal(signals, "storage:snapshot.failed:EIO").versions).toEqual({
      "2.30.0": { count: 1 },
      "2.31.0": { count: 1 },
    });
    expect(observedHours["essential-log"]).toEqual({ "2.30.0": 24, "2.31.0": 24 });
  });
});

describe("health signals", () => {
  test("reports runs without a clean exit as crashes, but not the run that exported the bundle", () => {
    const { signals } = extractSignals(
      load({
        createdAt: NOW,
        health: [
          ...healthRun({
            pid: 1,
            startedAt: NOW - 30 * HOUR,
            hours: 5,
            clean: false,
            rssStartMiB: 900,
          }),
          ...healthRun({ pid: 2, startedAt: NOW - 20 * HOUR, hours: 4, clean: true }),
          ...healthRun({ pid: 3, startedAt: NOW - 3 * HOUR, hours: 3, clean: false }),
        ],
      }),
    );
    const crashed = signal(signals, "backend:crashed");
    expect(crashed.count).toBe(1);
    expect(crashed.evidence.lastRssMiBBeforeCrash).toBe(900);
  });

  test("reports steady RSS growth through a long run, not a flat one", () => {
    const growing = extractSignals(
      load({
        createdAt: NOW,
        health: healthRun({
          pid: 1,
          startedAt: NOW - 10 * HOUR,
          hours: 10,
          clean: false,
          rssMiBPerHour: 60,
        }),
      }),
    );
    const growth = signal(growing.signals, "backend:rss-growth");
    expect(growth.measure.kind).toBe("gauge");
    expect(growth.measure.value).toBeCloseTo(60, 0);
    const flat = extractSignals(
      load({
        createdAt: NOW,
        health: healthRun({ pid: 1, startedAt: NOW - 10 * HOUR, hours: 10, clean: false }),
      }),
    );
    expect(flat.signals.some((candidate) => candidate.signature === "backend:rss-growth")).toBe(
      false,
    );
  });

  test("reports stalls, high CPU and failing or busy recurring jobs from the run's totals", () => {
    const { signals, observedHours } = extractSignals(
      load({
        createdAt: NOW,
        appVersion: "2.30.0",
        health: healthRun({
          pid: 1,
          startedAt: NOW - 2 * HOUR,
          hours: 2,
          clean: false,
          cpuPercent: 40,
          stalls: 6,
          worstStallMs: 2400,
          jobs: { "git-scan": { started: 100, failed: 5, totalMs: 40 * 60 * 1000 } },
        }),
      }),
    );
    expect(signal(signals, "backend:event-loop-stalls").count).toBe(6);
    expect(signal(signals, "backend:event-loop-stalls").evidence.worstStallMs).toBe(2400);
    expect(signal(signals, "backend:cpu").measure.value).toBeCloseTo(40, 0);
    const failed = signal(signals, "recurring:git-scan:failed");
    expect(failed.count).toBe(5);
    expect(failed.evidence.failureRate).toBe(0.05);
    expect(signal(signals, "recurring:git-scan:busy").measure.value).toBe(20 * 60 * 1000);
    expect(observedHours["health-summary"]).toEqual({ "2.30.0": 2 });
  });
});

describe("database signals", () => {
  test("reports slow series, lease timeouts and busy transactions over the exporting run", () => {
    const { signals, observedHours } = extractSignals(
      load({
        createdAt: NOW,
        appVersion: "2.30.0",
        health: healthRun({ pid: 1, startedAt: NOW - 12 * HOUR, hours: 12, clean: false }),
        database: {
          main: { fileBytes: 1, walBytes: 600 * 1024 * 1024 },
          leaseWaits: {
            families: { kanban: { acquired: 3, timedOut: 2, maxWaitMs: 5000 } },
            transactionsBusy: 1,
          },
          slowOperations: {
            series: {
              "main:select:sessions": { count: 6, totalMs: 1200, maxMs: 300 },
              "main:insert:noise": { count: 1, totalMs: 120, maxMs: 120 },
            },
          },
        },
      }),
    );
    const slow = signal(signals, "storage:slow:main:select:sessions");
    // Six over a 12-hour run is twelve a day.
    expect(slow.measure.value).toBe(12);
    expect(
      signals.some((candidate) => candidate.signature === "storage:slow:main:insert:noise"),
    ).toBe(false);
    expect(signal(signals, "storage:lease-timeout:kanban").count).toBe(2);
    expect(signal(signals, "storage:lease-wait:kanban").evidence.maxWaitMs).toBe(5000);
    expect(signal(signals, "storage:busy").count).toBe(1);
    expect(signal(signals, "storage:wal-large").measure.value).toBe(600);
    expect(observedHours.database).toEqual({ "2.30.0": 12 });
  });
});

describe("ranking", () => {
  test("a crash outranks a frequent warning, and frequency raises a score", () => {
    expect(
      scoreSignal({
        category: "crash",
        measure: { kind: "rate", unit: "", value: 0.2 },
        activeDays: 1,
      }),
    ).toBeGreaterThan(
      scoreSignal({
        category: "warning",
        measure: { kind: "rate", unit: "", value: 500 },
        activeDays: 7,
      }),
    );
    expect(
      scoreSignal({
        category: "fault",
        measure: { kind: "rate", unit: "", value: 50 },
        activeDays: 3,
      }),
    ).toBeGreaterThan(
      scoreSignal({
        category: "fault",
        measure: { kind: "rate", unit: "", value: 1 },
        activeDays: 3,
      }),
    );
  });

  test("compares app versions numerically, with a prerelease before its release", () => {
    expect(compareVersions("2.10.0", "2.9.9")).toBeGreaterThan(0);
    expect(compareVersions("v2.30.0", "2.30.0")).toBe(0);
    expect(compareVersions("2.30.0-beta.1", "2.30.0")).toBeLessThan(0);
  });
});
