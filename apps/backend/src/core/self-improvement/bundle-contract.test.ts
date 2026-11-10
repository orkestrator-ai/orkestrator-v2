/**
 * The digest reads what the backend writes. This builds a bundle with the
 * backend's own `buildDiagnosticsBundle` (redaction pass included), from
 * essential lines projected by the same function the essential log uses, and
 * reads it back through the digest. A change to the bundle's layout or the
 * essential log's shape fails here rather than as a quietly empty digest.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildDiagnosticsBundle } from "../diagnostics-bundle.js";
import { projectEssentialRecord } from "@orkestrator/protocol/log-essential";
import type { LogRecord } from "@orkestrator/protocol/logger";
import { readBundle } from "./bundle.js";
import { extractSignals } from "./signals.js";
import { HOUR, healthRun, temporaryDirectory } from "./testing/fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const ENVIRONMENT = "6e0a6a7e-1111-4222-8333-944445555666";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function line(
  at: number,
  level: LogRecord["level"],
  area: string,
  event: string,
  fields: LogRecord["fields"],
) {
  const projected = projectEssentialRecord(
    { orklog: 1, ts: new Date(at).toISOString(), level, area, event, fields },
    new Date(at).toISOString(),
  );
  if (!projected) throw new Error(`${area}:${event} at ${level} does not reach the essential log`);
  return JSON.stringify(projected);
}

test("a bundle the backend builds digests into the expected signals", async () => {
  const { dir, remove } = temporaryDirectory("improvement-contract-");
  cleanups.push(remove);
  const logsDir = path.join(dir, "logs");
  mkdirSync(path.join(logsDir, "essential"), { recursive: true });
  writeFileSync(
    path.join(logsDir, "essential", "essential.jsonl"),
    [
      line(NOW - 6 * HOUR, "info", "backend", "starting", { version: "2.30.0" }),
      line(NOW - 5 * HOUR, "warn", "local-server", "bridge.exited", {
        key: `codex:${ENVIRONMENT}`,
        pid: 4242,
        code: null,
        signal: "SIGKILL",
        requested: false,
      }),
      line(NOW - 4 * HOUR, "error", "storage", "snapshot.failed", {
        retryAt: new Date(NOW).toISOString(),
        error: { name: "Error", code: "ENOSPC", message: "disk full at /home/someone/data" },
      }),
      line(NOW - 3 * HOUR, "warn", "renderer-errors", "error.recorded", {
        errorClass: "TypeError",
        boundary: "message-row",
        route: "environment",
        fingerprint: "0badf00d",
        count: 4,
      }),
    ].join("\n") + "\n",
  );

  const health = [
    ...healthRun({ pid: 1, startedAt: NOW - 30 * HOUR, hours: 4, clean: false }),
    ...healthRun({ pid: 2, startedAt: NOW - 6 * HOUR, hours: 6, clean: false }),
  ];
  const built = await buildDiagnosticsBundle({
    now: () => new Date(NOW),
    appVersion: "2.30.0",
    platform: "linux",
    arch: "x64",
    bunVersion: "1.4.4",
    redaction: {
      dataDir: path.join(dir, "data"),
      homeDir: "/home/someone",
      userName: "someone",
      hostName: "host",
    },
    logsDir,
    debugLogging: false,
    json: [
      {
        path: "health-summary.json",
        description: "Health.",
        read: () => health,
        absentAs: "None.",
      },
      {
        path: "database.json",
        description: "Database.",
        read: () => ({
          main: { fileBytes: 10, walBytes: 0, freelistBytes: 0 },
          leaseWaits: {
            families: { kanban: { acquired: 2, timedOut: 1, maxWaitMs: 10 } },
            transactionsBusy: 0,
          },
          slowOperations: {
            series: { "main:select:sessions": { count: 4, totalMs: 800, maxMs: 300 } },
          },
        }),
        absentAs: "None.",
      },
    ],
    notCollected: [{ name: "prompts", reason: "Never collected." }],
  });
  const archive = path.join(dir, "bundle.tar.gz");
  writeFileSync(archive, built.archive);

  const data = await readBundle(archive);
  expect(data.manifest.appVersion).toBe("2.30.0");
  expect(data.essential).toHaveLength(4);
  expect(data.essentialUnreadable).toBe(0);

  const { signals, observedHours } = extractSignals(data);
  const signatures = signals.map((signal) => signal.signature);
  expect(signatures).toEqual(
    expect.arrayContaining([
      "backend:crashed",
      "local-server:bridge.exited:codex:SIGKILL",
      "storage:snapshot.failed:ENOSPC",
      "renderer-errors:TypeError:message-row:0badf00d",
      "storage:slow:main:select:sessions",
      "storage:lease-timeout:kanban",
    ]),
  );
  // The crashed run outranks everything else, and no signature carries an environment id.
  expect(signals[0]!.signature).toBe("backend:crashed");
  expect(signatures.some((signature) => signature.includes(ENVIRONMENT.slice(0, 8)))).toBe(false);
  expect(observedHours["essential-log"]).toEqual({ "2.30.0": 6 });
  expect(observedHours.database).toEqual({ "2.30.0": 6 });
});
