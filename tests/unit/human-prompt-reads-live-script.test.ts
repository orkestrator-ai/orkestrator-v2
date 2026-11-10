import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { signalHealth } from "../../scripts/container-tmux-tab-live";
import {
  parseOptions,
  providerRequestRates,
  providerRequests,
} from "../../scripts/human-prompt-reads-live";
import { gatewayMetrics } from "../../scripts/tmux-mail-inject-live";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const metrics = (unattributed: number | undefined, kinds: Record<string, number>) => ({
  recurringWork: {
    metrics: {
      kinds: Object.fromEntries(
        Object.entries(kinds).map(([kind, value]) => [
          kind,
          { started: 1, workUnits: { "provider-request": value } },
        ]),
      ),
      unattributed: {
        bytes: 0,
        workUnits: unattributed === undefined ? {} : { "provider-request": unattributed },
      },
    },
  },
});

test("parses options with defaults and rejects bad values", () => {
  expect(parseOptions(["--profile", "bg9-after"])).toMatchObject({
    profile: "bg9-after",
    idleMs: 60_000,
    workingMs: 180_000,
  });
  expect(
    parseOptions([
      "--profile",
      "bg9",
      "--checkout",
      "/abs/base",
      "--label",
      "base",
      "--working-ms",
      "5000",
    ]),
  ).toMatchObject({ checkout: "/abs/base", label: "base", workingMs: 5000 });
  expect(() => parseOptions([])).toThrow("--profile is required");
  expect(() => parseOptions(["--profile", "Bad Name"])).toThrow();
  expect(() => parseOptions(["--profile", "p", "--checkout", "relative"])).toThrow();
  expect(() => parseOptions(["--profile", "p", "--idle-ms", "10"])).toThrow();
  expect(() => parseOptions(["--profile", "p", "--bogus", "1"])).toThrow("Unknown option");
});

test("reads unattributed and per-kind provider requests, treating a missing unit as zero", () => {
  expect(providerRequests(metrics(7, { "native-activity-sweep": 30, "diff-scan": 0 }))).toEqual({
    unattributed: 7,
    byKind: { "native-activity-sweep": 30 },
  });
  expect(providerRequests(metrics(undefined, {}))).toEqual({ unattributed: 0, byKind: {} });
  expect(() => providerRequests({})).toThrow("unavailable");
  expect(() => providerRequests(metrics(1, { bad: -1 }))).toThrow("Invalid");
});

test("rates scale the window to a minute and refuse counters that went backwards", () => {
  const before = { unattributed: 10, byKind: { "native-activity-sweep": 30 } };
  const after = { unattributed: 34, byKind: { "native-activity-sweep": 90, "queue-scan": 4 } };
  expect(providerRequestRates(before, after, 120_000)).toEqual({
    unattributed: 24,
    unattributedPerMinute: 12,
    byKindPerMinute: { "native-activity-sweep": 30, "queue-scan": 2 },
  });
  expect(() => providerRequestRates(after, before, 1_000)).toThrow("backwards");
  expect(() => providerRequestRates(before, after, 0)).toThrow("no duration");
});

test("signal health keeps non-zero states and is null when a backend publishes none", () => {
  expect(
    signalHealth({
      recurringWork: {
        signals: [
          {
            name: "tmux-hook-signal",
            status: {
              containers: 1,
              states: { confirmed: 1, armed: 0, unconfirmed: 0 },
              fallback: 0,
              demotions: { "missed-change": 0 },
              rings: 3,
            },
          },
          { name: 7 },
        ],
      },
    }),
  ).toEqual({
    "tmux-hook-signal": {
      containers: 1,
      states: { confirmed: 1 },
      fallback: 0,
      rings: 3,
      demotions: {},
    },
  });
  expect(signalHealth({ recurringWork: {} })).toBeNull();
  expect(signalHealth(null)).toBeNull();
});

test("gateway metrics refuse a non-loopback gateway and send the token only to loopback", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bg9-metrics-"));
  dirs.push(dir);
  const authFile = path.join(dir, "auth.json");
  writeFileSync(authFile, JSON.stringify({ token: "fixture-token" }));
  await expect(
    gatewayMetrics({ browserUrl: "http://example.com/", authFile } as never),
  ).rejects.toThrow("not loopback");
  const seen: string[] = [];
  const result = await gatewayMetrics(
    { browserUrl: "http://127.0.0.1:1/", authFile } as never,
    undefined,
    async (url, init) => {
      seen.push(`${url.pathname} ${new Headers(init.headers).get("authorization")}`);
      return Response.json({ ok: true });
    },
  );
  expect(result).toEqual({ ok: true });
  expect(seen).toEqual(["/__orkestrator/metrics Bearer fixture-token"]);
  await expect(
    gatewayMetrics(
      { browserUrl: "http://127.0.0.1:1/", authFile } as never,
      undefined,
      async () => new Response("", { status: 503 }),
    ),
  ).rejects.toThrow("HTTP 503");
});
