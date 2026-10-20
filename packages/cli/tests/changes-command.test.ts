import { afterEach, describe, expect, test } from "bun:test";
import type { LineCount } from "@orkestrator/protocol/change-measurements";
import type { ChangeFileRow, ChangeProjection } from "@orkestrator/protocol/change-resources";
import { publicErrorEnvelope, publicSuccessEnvelope } from "@orkestrator/protocol/public-api";
import type {
  PublicChangesHistory,
  PublicChangesView,
} from "@orkestrator/protocol/public-api-resources";
import { formatLineCount } from "../src/client/commands/changes.js";
import {
  createSandbox,
  defaultResponder,
  envelope,
  startFakeGateway,
  type ClientSandbox,
  type FakeGateway,
  type RecordedRequest,
} from "./support/client-harness.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const exact = (value: number): LineCount => ({ value, quality: "complete", bound: "exact" });
const NA: LineCount = { value: null, quality: "not-applicable", bound: "none" };
const UNKNOWN: LineCount = { value: null, quality: "unknown", bound: "none" };

function row(
  path: string,
  additions: LineCount,
  deletions: LineCount,
  extra: Partial<ChangeFileRow> = {},
): ChangeFileRow {
  return {
    rowId: `m1:${path}`,
    pathId: path,
    oldPathDisplay: path,
    newPathDisplay: path,
    status: "modified",
    fileKind: "text",
    additions,
    deletions,
    bodyAvailability: "available",
    reasonKey: null,
    detail: null,
    ...extra,
  };
}

const ROWS = [
  row("src/a.ts", exact(3), exact(1)),
  row("img.png", NA, NA, { fileKind: "binary" }),
  row("big.log", UNKNOWN, UNKNOWN, { status: "added", reasonKey: "changes.reason.count-omitted" }),
];

function projection(overrides: Partial<ChangeProjection> = {}): ChangeProjection {
  return {
    schemaVersion: 1,
    resourceKey: "environment-net/environment/env-1/live",
    ownerGeneration: "gen",
    revision: 4,
    measurementId: "m1",
    state: "partial",
    availability: "ready",
    observationState: "fresh",
    coverageState: "partial",
    labelKey: "changes.scope.environment-net",
    labelArgs: {},
    hasFileChanges: true,
    hasTextChanges: true,
    badge: { visible: true, mode: "counts" },
    counters: {
      additions: { value: 3, quality: "partial", bound: "none" },
      deletions: { value: 1, quality: "partial", bound: "none" },
      changedFiles: 3,
    },
    provenanceLabelKey: "changes.provenance.observed",
    reasonKeys: ["changes.reason.count-omitted"],
    freshness: {
      lastAttemptAt: null,
      lastSuccessfulCheckAt: "2026-10-20T12:00:00.000Z",
      lastContentChangeObservedAt: null,
      observedAt: null,
      requiredObservationEpoch: null,
      checkedObservationEpoch: null,
    },
    detail: null,
    filePage: { snapshotToken: "gen:4:m1", rows: ROWS, nextCursor: "cur-2", totalRows: 5 },
    actions: [],
    ...overrides,
  };
}

const VIEW: PublicChangesView = {
  environmentId: "env-1",
  scope: "environment",
  projection: projection(),
  files: { rows: ROWS, nextCursor: "cur-2", totalRows: 5 },
};

async function fixture(
  respond: (request: RecordedRequest) => Response | undefined,
): Promise<{ box: ClientSandbox; gateway: FakeGateway }> {
  const box = await createSandbox();
  const gateway = await startFakeGateway(
    (request) => respond(request) ?? defaultResponder()(request),
  );
  cleanups.push(
    () => box.cleanup(),
    () => gateway.stop(),
  );
  const dataDir = await box.publishDescriptor(gateway);
  await box.run(["connection", "add", "local", "--data-dir", dataDir, "--default", "--no-check"]);
  return { box, gateway };
}

function inputsOf(gateway: FakeGateway, action: string): unknown[] {
  return gateway.requests
    .filter((request) => request.body.args.action === action)
    .map((request) => request.body.args.input);
}

describe("changes view", () => {
  test("--json prints the action result verbatim and forwards paging options", async () => {
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "changes.view"
        ? envelope(publicSuccessEnvelope("changes.view", VIEW))
        : undefined,
    );
    const run = await box.run([
      "changes",
      "view",
      "env-1",
      "--page-size",
      "3",
      "--cursor",
      "cur-1",
      "--scope",
      "environment",
      "--json",
    ]);
    expect(run.code).toBe(0);
    expect(run.err).toBe("");
    const printed = JSON.parse(run.out);
    expect(printed).toMatchObject({ ok: true, action: "changes.view" });
    expect(printed.result).toEqual(VIEW);
    expect(inputsOf(gateway, "changes.view")).toEqual([
      { environmentId: "env-1", scope: "environment", pageSize: 3, cursor: "cur-1" },
    ]);
    // A read never submits a request key or reads capabilities first.
    expect(gateway.requests.every((request) => request.body.args.request === undefined)).toBe(true);
  });

  test("human output shows scope, state, count quality and rows without inventing zeros", async () => {
    const { box } = await fixture((request) =>
      request.body.args.action === "changes.view"
        ? envelope(publicSuccessEnvelope("changes.view", VIEW))
        : undefined,
    );
    const run = await box.run(["changes", "view", "env-1"]);
    expect(run.code).toBe(0);
    const lines = run.out.split("\n");
    expect(lines[0]).toBe("Environment changes (environment env-1)");
    expect(run.out).toContain("partial, observation fresh, coverage partial");
    expect(run.out).toContain("3 files  ~+3 ~-1");
    expect(run.out).toContain("observed in the workspace");
    expect(run.out).toContain("count omitted");
    const line = (path: string) => lines.find((text) => text.startsWith(path)) ?? "";
    expect(line("src/a.ts")).toMatch(/modified\s+\+3 -1/);
    expect(line("img.png")).toMatch(/modified\s+binary/);
    expect(line("big.log")).toMatch(/added\s+\+\? -\?\s+count omitted/);
    expect(run.out).not.toMatch(/\+0|-0/);
    expect(run.out).toContain("3 of 5 files shown; next page: --cursor cur-2");
  });

  test("an unmeasured environment says so", async () => {
    const pending: PublicChangesView = {
      ...VIEW,
      projection: projection({
        measurementId: null,
        state: "loading",
        availability: "pending",
        coverageState: "unknown",
        hasFileChanges: null,
        counters: { additions: UNKNOWN, deletions: UNKNOWN, changedFiles: null },
        reasonKeys: [],
        filePage: null,
      }),
      files: { rows: [], nextCursor: null, totalRows: null },
    };
    const { box } = await fixture((request) =>
      request.body.args.action === "changes.view"
        ? envelope(publicSuccessEnvelope("changes.view", pending))
        : undefined,
    );
    const run = await box.run(["changes", "view", "env-1"]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("not measured yet");
    expect(run.out).not.toContain("0 files");
  });

  test("backend errors keep their code and exit class", async () => {
    const { box } = await fixture((request) => {
      const action = request.body.args.action;
      const input = request.body.args.input as { environmentId?: string; cursor?: string };
      if (action !== "changes.view") return undefined;
      if (input.cursor) {
        return envelope(
          publicErrorEnvelope("changes.view", {
            code: "cursor-expired",
            message: "The changes moved on",
          }),
        );
      }
      if (input.environmentId === "env-off") {
        return envelope(
          publicErrorEnvelope("changes.view", {
            code: "capability-unavailable",
            message: "Change tracking is unavailable in this backend",
          }),
        );
      }
      return envelope(publicErrorEnvelope("changes.view", { code: "not-found", message: "gone" }));
    });
    const missing = await box.run(["changes", "view", "env-x", "--json"]);
    expect(missing.code).toBe(3);
    expect(JSON.parse(missing.out).error.code).toBe("not-found");
    const stale = await box.run(["changes", "view", "env-1", "--cursor", "old", "--json"]);
    expect(stale.code).toBe(8);
    expect(JSON.parse(stale.out).error.code).toBe("cursor-expired");
    const off = await box.run(["changes", "view", "env-off"]);
    expect(off.code).toBe(8);
    expect(off.err).toContain("capability-unavailable");
  });

  test("refuses bad arguments before contacting the backend", async () => {
    const { box, gateway } = await fixture(() => undefined);
    const before = gateway.requests.length;
    const noTarget = await box.run(["changes", "view", "--json"]);
    expect(noTarget.code).toBe(2);
    const badScope = await box.run(["changes", "view", "env-1", "--scope", "thread", "--json"]);
    expect(badScope.code).toBe(2);
    expect(JSON.parse(badScope.out).error.code).toBe("invalid-input");
    const badSize = await box.run(["changes", "view", "env-1", "--page-size", "many", "--json"]);
    expect(badSize.code).toBe(2);
    const idOutput = await box.run(["changes", "view", "env-1", "--output", "id"]);
    expect(idOutput.code).toBe(2);
    expect(gateway.requests.length).toBe(before);
  });

  test("help lists the group and documents the count qualities", async () => {
    const box = await createSandbox();
    cleanups.push(() => box.cleanup());
    const root = await box.run(["help"]);
    expect(root.out).toMatch(/changes\s+Read the file and line changes/);
    const help = await box.run(["help", "changes", "view"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("Usage: orkestrator changes view ENVIRONMENT [options]");
    expect(help.out).toContain("--page-size N");
    expect(help.out).toContain("? unknown");
  });
});

describe("changes history", () => {
  test("prints each turn's backend counts and forwards the cursor", async () => {
    const turn = projection({
      resourceKey: "turn-net/turn/t1/final",
      labelKey: "changes.scope.turn-net",
      state: "ready",
      counters: { additions: exact(2), deletions: exact(1), changedFiles: 1 },
      filePage: null,
    });
    const history: PublicChangesHistory = {
      sessionId: "ses_abc",
      entries: [
        {
          turnId: "t1",
          segmentId: "s1",
          lifecycle: "completed",
          startedAt: "2026-10-20T11:59:00.000Z",
          finishedAt: "2026-10-20T12:00:00.000Z",
          turnResourceKey: turn.resourceKey,
          measurementId: "m2",
          presentation: {
            schemaVersion: 1,
            turnId: "t1",
            revision: 1,
            changes: [{ role: "turn-net", resourceKey: turn.resourceKey, prominence: "primary" }],
          },
          projections: { [turn.resourceKey]: turn },
        },
        {
          turnId: "t2",
          segmentId: "s1",
          lifecycle: "running",
          startedAt: "2026-10-20T12:01:00.000Z",
          finishedAt: null,
          turnResourceKey: "turn-net/turn/t2/final",
          measurementId: null,
          presentation: { schemaVersion: 1, turnId: "t2", revision: 0, changes: [] },
          projections: {},
        },
      ],
      nextCursor: "7",
    };
    const { box, gateway } = await fixture((request) =>
      request.body.args.action === "changes.history"
        ? envelope(publicSuccessEnvelope("changes.history", history))
        : undefined,
    );
    const run = await box.run(["changes", "history", "ses_abc", "--limit", "2", "--cursor", "3"]);
    expect(run.code).toBe(0);
    expect(inputsOf(gateway, "changes.history")).toEqual([
      { sessionId: "ses_abc", limit: 2, cursor: "3" },
    ]);
    const lines = run.out.split("\n");
    expect(lines.find((line) => line.startsWith("t1"))).toMatch(/completed.*1 file  \+2 -1/);
    expect(lines.find((line) => line.startsWith("t2"))).toMatch(/running\s+-\s+unavailable/);
    expect(run.out).toContain("newer turns: --cursor 7");
    const json = await box.run(["changes", "history", "ses_abc", "--json"]);
    expect(JSON.parse(json.out).result).toEqual(history);
  });
});

describe("formatLineCount", () => {
  test("marks quality and bounds and leaves non-text counts empty", () => {
    expect(formatLineCount("+", exact(12))).toBe("+12");
    expect(formatLineCount("-", exact(0))).toBe("-0");
    expect(formatLineCount("+", { value: 12, quality: "partial", bound: "none" })).toBe("~+12");
    expect(formatLineCount("+", { value: 12, quality: "estimated", bound: "none" })).toBe("~+12");
    expect(formatLineCount("+", { value: 12, quality: "partial", bound: "lower" })).toBe("≥+12");
    expect(formatLineCount("-", UNKNOWN)).toBe("-?");
    expect(formatLineCount("+", NA)).toBe("");
  });
});
