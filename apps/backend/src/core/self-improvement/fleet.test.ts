import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { mergeMachineSignals, newestVersion } from "./fleet.js";
import { insightsDir, loadNotes, loadThemes, runInsights, saveThemes } from "./insights/analyze.js";
import { type ModelCall, type ModelRunner, NOTES_MODEL } from "./insights/model.js";
import {
  answerLeafConversations,
  leafInsightsDir,
  type LeafNode,
  parseLeafSelection,
} from "./leaves.js";
import {
  applyLedgerChange,
  buildDigest,
  emptyLedger,
  listDigests,
  loadLedger,
  writeAtomic,
} from "./ledger.js";
import { runLoop } from "./loop.js";
import { extractSignals } from "./signals.js";
import { FakeBoard } from "./testing/fake-board.js";
import {
  bundleData,
  DAY,
  type EssentialLine,
  type FixtureBundle,
  healthRun,
  HOUR,
  temporaryDirectory,
} from "./testing/fixtures.js";
import { claudeJsonl, writeTranscript } from "./testing/transcript-fixtures.js";

const NOW = Date.parse("2026-11-09T09:00:00.000Z");
const CWD = "/work/project";
const ENV = "6e0a6a7e-1111-4222-8333-944445555666";
const KILLS = "local-server:bridge.exited:codex:SIGKILL";
const DISK = "storage:snapshot.failed:ENOSPC";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function starting(at: number, version: string): EssentialLine {
  return { at, level: "info", area: "backend", event: "starting", fields: { version } };
}

function repeat(from: number, count: number, spacing: number, line: Omit<EssentialLine, "at">) {
  return Array.from({ length: count }, (_, index) => ({ ...line, at: from + index * spacing }));
}

const kill = (from: number, count: number) =>
  repeat(from, count, DAY / 6, {
    level: "warn",
    area: "local-server",
    event: "bridge.exited",
    fields: { key: `codex:${ENV}`, signal: "SIGKILL", requested: false },
  });
const diskFull = (from: number, count: number) =>
  repeat(from, count, DAY / 2, {
    level: "error",
    area: "storage",
    event: "snapshot.failed",
    fields: { "error.code": "ENOSPC" },
  });

/** Ten days on one version, with `lines` on top. */
function machine(version: string, lines: EssentialLine[] = []): FixtureBundle {
  return {
    createdAt: NOW,
    appVersion: version,
    essential: [starting(NOW - 10 * DAY, version), ...lines],
  };
}

describe("signals from several machines", () => {
  test("one machine's extraction is returned unchanged", () => {
    const extracted = extractSignals(bundleData(machine("2.30.0", kill(NOW - 9 * DAY, 20))));
    expect(mergeMachineSignals([{ nodeId: "a", name: "A", extracted }])).toBe(extracted);
  });

  test("the same signature is one signal, its rate per machine-day over every machine", () => {
    const here = extractSignals(bundleData(machine("2.30.0", kill(NOW - 9 * DAY, 40)), "a"));
    const leaf = extractSignals(
      bundleData(
        machine("2.31.0", [...kill(NOW - 9 * DAY, 20), ...diskFull(NOW - 9 * DAY, 6)]),
        "b",
      ),
    );
    const quiet = extractSignals(bundleData(machine("2.31.0"), "c"));
    const merged = mergeMachineSignals([
      { nodeId: "a", name: "Desk", extracted: here },
      { nodeId: "b", name: "VPS", extracted: leaf },
      { nodeId: "c", name: "Laptop", extracted: quiet },
    ]);

    const kills = merged.signals.find((signal) => signal.signature === KILLS)!;
    expect(kills.count).toBe(60);
    expect(kills.versions).toEqual({ "2.30.0": { count: 40 }, "2.31.0": { count: 20 } });
    expect(kills.evidence.machines).toBe("Desk, VPS");
    // Every machine watched about ten days, the quiet one included: 60 over 30.
    expect(kills.measure.value).toBeCloseTo(2, 1);
    // Observed hours are summed, so a verdict measures the same quantity.
    const hours = merged.observedHours["essential-log"];
    expect(hours["2.30.0"]).toBeCloseTo(240, 0);
    expect(hours["2.31.0"]).toBeCloseTo(480, 0);

    // A problem only the leaf had is still a signal, and says where it was.
    const disk = merged.signals.find((signal) => signal.signature === DISK)!;
    expect(disk.count).toBe(6);
    expect(disk.evidence.machines).toBe("VPS");
    // Ranked by the fleet's total, not the per-machine average.
    const alone = leaf.signals.find((signal) => signal.signature === DISK)!;
    expect(disk.score).toBe(alone.score);
  });

  test.each(["backend.exited", "backend.exited-recovering"])(
    "merges %s evidence even when the lead machine has only historical exits",
    (event) => {
      const from = NOW - DAY;
      const exited = (fields: EssentialLine["fields"], count: number) =>
        repeat(from, count, HOUR, {
          level: "error",
          area: "desktop",
          event,
          fields: { "error.name": "Error", ...fields },
        });
      const killed = { exitCause: "killed", "error.signal": "SIGKILL", crashReport: false };
      const merged = mergeMachineSignals([
        {
          nodeId: "a",
          name: "Desk",
          extracted: extractSignals(bundleData(machine("2.30.0", exited({}, 5)), "a")),
        },
        {
          nodeId: "b",
          name: "VPS",
          extracted: extractSignals(
            bundleData(machine("2.31.0", exited({ ...killed, oomKills: 3, ranForMs: 8 }, 2)), "b"),
          ),
        },
        {
          nodeId: "c",
          name: "Laptop",
          extracted: extractSignals(
            bundleData(
              machine("2.31.0", [
                ...exited({ ...killed, oomKills: 0 }, 1),
                ...exited(
                  {
                    exitCause: "crashed",
                    "error.signal": "SIGABRT",
                    crashReport: true,
                    ranForMs: 15,
                  },
                  1,
                ),
              ]),
              "c",
            ),
          ),
        },
      ]);
      const exits = merged.signals.find((signal) => signal.signature === `desktop:${event}:Error`);
      expect(exits?.count).toBe(9);
      expect(exits?.evidence).toMatchObject({
        "exitCause.killed": 3,
        "exitCause.crashed": 1,
        "error.signal.SIGKILL": 3,
        "error.signal.SIGABRT": 1,
        "crashReport.false": 3,
        "crashReport.true": 1,
        oomKills: 3,
        ranForMs: 15,
      });
    },
  );

  test("rates use only the hours of machines that observed their source", () => {
    const watched = extractSignals(
      bundleData({
        ...machine("2.31.0"),
        health: healthRun({
          pid: 1,
          startedAt: NOW - 12 * HOUR,
          hours: 12,
          clean: false,
          jobs: { poll: { started: 4, failed: 2, totalMs: 400 } },
        }),
        database: {
          slowOperations: {
            series: { "main:select:sessions": { count: 6, totalMs: 1200, maxMs: 300 } },
          },
        },
      }),
    );
    const uncovered = extractSignals(bundleData(machine("2.31.0")));
    const merged = mergeMachineSignals([
      { nodeId: "watched", name: "Watched", extracted: watched },
      { nodeId: "uncovered", name: "Uncovered", extracted: uncovered },
    ]);
    expect(
      merged.signals.find((signal) => signal.signature === "storage:slow:main:select:sessions")
        ?.measure.value,
    ).toBe(12);
    expect(
      merged.signals.find((signal) => signal.signature === "recurring:poll:failed")?.measure.value,
    ).toBe(4);
  });

  test("health and fallback crash counts use each machine's own source hours", () => {
    const version = "2.31.0";
    const health = extractSignals(
      bundleData({
        ...machine(version),
        health: [
          ...healthRun({ pid: 1, startedAt: NOW - 4 * DAY, hours: 12, clean: false }),
          ...healthRun({ pid: 2, startedAt: NOW - 2 * DAY, hours: 12, clean: true }),
        ],
      }),
    );
    const log = extractSignals(
      bundleData({
        createdAt: NOW,
        appVersion: version,
        essential: [
          starting(NOW - DAY, version),
          {
            at: NOW - HOUR,
            area: "backend",
            event: "previous-run",
            fields: { outcome: "crashed" },
          },
        ],
      }),
    );
    const machines = [
      { nodeId: "health", name: "Health", extracted: health },
      { nodeId: "log", name: "Log", extracted: log },
    ];
    const merged = mergeMachineSignals(machines);
    expect(merged.signals.find((signal) => signal.signature === "backend:crashed")).toMatchObject({
      count: 2,
      measure: { value: 1 },
    });
    const data = bundleData(machine(version));
    const evidence = { machines, fleet: true, history: [] };
    const ledger = emptyLedger();
    const baseline = buildDigest(data, merged, null, ledger, new Date(NOW), undefined, evidence);
    applyLedgerChange(ledger, "backend:crashed", { status: "fixed", fixedIn: version }, [baseline]);
    const after = buildDigest(data, merged, baseline, ledger, new Date(NOW), undefined, evidence);
    expect(after.judgements[0]).toMatchObject({
      baseline: 1,
      postFixHours: 24,
      postFixValue: 1,
      verdict: "unchanged",
    });
  });

  test("a ticket done now is fixed only after the newest version running anywhere", () => {
    expect(newestVersion(["2.30.0", "2.31.1", "2.31.0"])).toBe("2.31.1");
    expect(newestVersion(["unknown", "2.30.0"])).toBe("2.30.0");
    expect(newestVersion(["unknown"])).toBe("unknown");
  });
});

describe("a run on a command node", () => {
  /** A model that notes "npm" whenever a person mentions it, and groups those notes into one theme. */
  function fakeModel(calls: ModelCall[]): ModelRunner {
    return (async (call: ModelCall) => {
      calls.push(call);
      if (call.model === NOTES_MODEL) {
        const npm = /PERSON: .*npm/.test(call.prompt);
        return {
          output: {
            notes: npm
              ? [
                  {
                    kind: "repeated-instruction",
                    area: "package manager",
                    summary: "Had to say use mise.",
                    quote: "not npm",
                    severity: 2,
                    fixWhere: "instructions",
                  },
                ]
              : [],
          },
          costUsd: 0.01,
        };
      }
      const noteIds = call.prompt
        .split("\n")
        .filter((line) => line.includes("package manager"))
        .map((line) => line.split(" | ")[0]!);
      return {
        output: {
          themes: [
            {
              slug: "use-mise-not-npm",
              title: "Agents keep reaching for npm",
              kind: "repeated-instruction",
              fixWhere: "instructions",
              summary: "People keep telling agents to use mise.",
              suggestion: "Add a rule to AGENTS.md.",
              acceptance: "Nobody has to say it.",
              severity: 2,
              noteIds,
            },
          ],
        },
        costUsd: 0.1,
      };
    }) as ModelRunner;
  }

  function histories(name: string) {
    const { dir, remove } = temporaryDirectory(`self-improvement-${name}-`);
    cleanups.push(remove);
    const projects = path.join(dir, "projects");
    return {
      dir,
      sources: { claudeProjectDirs: [projects], codexSessionDirs: [] },
      write: (id: string, at: number, text: string) =>
        writeTranscript(
          path.join(projects, "-p", `${id}.jsonl`),
          claudeJsonl(id, CWD, [
            { user: text, at },
            { assistant: "OK.", at: at + 1000 },
          ]),
          at + 2000,
        ),
    };
  }

  /** A leaf answering over a JSON link, from its own histories. */
  function leafNode(
    nodeId: string,
    sources: { claudeProjectDirs: string[]; codexSessionDirs: string[] },
  ) {
    const asked: number[] = [];
    const node: Omit<LeafNode, "diagnostics"> = {
      nodeId,
      name: nodeId,
      async conversations({ cursor, maxSegments }) {
        asked.push(maxSegments);
        const answer = await answerLeafConversations({
          sources,
          excludeDirs: [],
          cursor: JSON.parse(JSON.stringify(cursor)),
          maxSegments,
          now: NOW,
        });
        return parseLeafSelection(JSON.parse(JSON.stringify(answer)), maxSegments);
      },
    };
    return { node, asked };
  }

  test("files a leaf's problem, says where it was, and marks a fix after every running version", async () => {
    const { dir, remove } = temporaryDirectory("self-improvement-fleet-");
    cleanups.push(remove);
    const stateDir = path.join(dir, "state");
    const board = new FakeBoard();
    const here = bundleData(machine("2.30.0"), "a");
    const leaf = bundleData(machine("2.31.0", diskFull(NOW - 9 * DAY, 18)), "b");
    const run = (now: number) =>
      runLoop({
        stateDir,
        data: here,
        board,
        now: () => new Date(now),
        insights: false,
        fleet: {
          self: { nodeId: "bk_desk", name: "Desk" },
          bundles: [{ nodeId: "bk_vps", name: "VPS", data: leaf, extracted: extractSignals(leaf) }],
        },
      });

    const first = await run(NOW);
    expect(first.created.map((item) => item.signature)).toContain(DISK);
    const ticket = board.ticketFor(DISK);
    expect(ticket.description).toContain("machines=VPS");
    const digestFile = path.join(stateDir, "digests", `${first.digestId}.json`);
    const digest = JSON.parse(readFileSync(digestFile, "utf8")) as {
      machines?: Array<{ name: string; appVersion: string }>;
    };
    expect(digest.machines?.map((entry) => [entry.name, entry.appVersion])).toEqual([
      ["Desk", "2.30.0"],
      ["VPS", "2.31.0"],
    ]);
    expect(readFileSync(digestFile.replace(/\.json$/, ".md"), "utf8")).toContain(
      "Machines: Desk (app 2.30.0",
    );

    ticket.status = "done";
    await run(NOW + HOUR);
    expect(loadLedger(stateDir).entries[DISK]).toMatchObject({
      status: "fixed",
      fixedAfter: "2.31.0",
    });
  });

  test("verification waits for the affected leaf and ignores new quiet machines", async () => {
    const { dir, remove } = temporaryDirectory("self-improvement-fleet-verdict-");
    cleanups.push(remove);
    const board = new FakeBoard();
    const leaf = (version: string, at: number, faulty: boolean, nodeId = "bk_vps") => {
      const data = bundleData(
        {
          createdAt: at,
          appVersion: version,
          essential: [
            starting(at - 10 * DAY, version),
            ...(faulty ? diskFull(at - 9 * DAY, 18) : []),
          ],
        },
        nodeId,
      );
      return { nodeId, name: nodeId, data, extracted: extractSignals(data) };
    };
    const run = (at: number, version: string, bundles: ReturnType<typeof leaf>[]) =>
      runLoop({
        stateDir: dir,
        data: leaf(version, at, false, "bk_desk").data,
        board,
        now: () => new Date(at),
        insights: false,
        fleet: { self: { nodeId: "bk_desk", name: "Desk" }, bundles },
      });

    await run(NOW, "2.30.0", [leaf("2.31.0", NOW, true)]);
    const ticket = board.ticketFor(DISK);
    ticket.status = "done";

    // The affected leaf already ran a newer release. Its absence when the
    // ticket goes Done cannot make that pre-fix release count as a fix.
    await run(NOW + DAY, "2.30.0", []);
    expect(loadLedger(dir).entries[DISK]?.fixedAfter).toBe("2.31.0");
    for (const present of [false, true]) {
      const at = NOW + (present ? 3 : 2) * DAY;
      const summary = await run(at, "2.32.0", present ? [leaf("2.31.0", at, true)] : []);
      expect(summary.verified).toEqual([]);
      const entry = loadLedger(dir).entries[DISK]!;
      expect(entry.status).toBe("fixed");
      expect(entry.observations.at(-1)?.verdict).toBe("awaiting-evidence");
    }
    const fixedAt = NOW + 4 * DAY;
    const stillFailing = await run(fixedAt, "2.32.0", [
      leaf("2.32.0", fixedAt, true),
      ...Array.from({ length: 10 }, (_, i) => leaf("2.32.0", fixedAt, false, `bk_quiet_${i}`)),
    ]);
    expect(stillFailing.verified).toEqual([]);
    expect(stillFailing.fixFailed.map(({ signature }) => signature)).toEqual([DISK]);
  });

  test.each([30, 64])(
    "a %i-leaf backlog rotates 29 remote slots and reserves local work",
    async (leafCount) => {
      const local = histories("budget");
      for (let i = 0; i < 3; i++) local.write(`local-${i}`, NOW - DAY, "All fine.");
      const parts = await answerLeafConversations({
        sources: local.sources,
        excludeDirs: [],
        cursor: { schemaVersion: 1, conversations: {} },
        maxSegments: 1,
        now: NOW,
      });
      const leaves = Array.from({ length: leafCount }, (_, i) => ({
        nodeId: `bk_${String(i).padStart(2, "0")}`,
        // Exercise the command-node cap even if a leaf sends more than requested.
        conversations: async () => ({ segments: parts.segments, skipped: [], waiting: 0 }),
      }));
      const calls: ModelCall[] = [];
      const run = () =>
        runInsights({
          stateDir: local.dir,
          data: bundleData(machine("2.30.0")),
          sources: local.sources,
          excludeDirs: [],
          now: NOW,
          runner: fakeModel(calls),
          statusOf: () => null,
          leaves,
        });
      const reviewed = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const result = await run();
        expect(result.read).toBe(30);
        const remote = Object.entries(result.leaves).filter(([, leaf]) => leaf.parts === 1);
        expect(remote).toHaveLength(29);
        remote.forEach(([nodeId]) => reviewed.add(nodeId));
      }
      expect(reviewed.size).toBe(leafCount);
      expect(calls).toHaveLength(90);
    },
  );

  test("a damaged saved note cannot prevent valid parts from grouping", async () => {
    const local = histories("bad-note");
    local.write("valid", NOW - DAY, "Use mise, not npm.");
    const dir = insightsDir(local.dir);
    writeAtomic(
      path.join(dir, "notes.json"),
      JSON.stringify({
        schemaVersion: 1,
        notes: [{ id: "bad", at: Number.MAX_VALUE }],
      }),
    );
    saveThemes(dir, { schemaVersion: 1, themes: {}, pendingGrouping: true });
    const run = () =>
      runInsights({
        stateDir: local.dir,
        data: bundleData(machine("2.30.0")),
        sources: local.sources,
        excludeDirs: [],
        now: NOW,
        runner: fakeModel([]),
        statusOf: () => null,
      });
    expect(await run()).toMatchObject({
      notesAdded: 1,
      themesChanged: 1,
      groupingPending: false,
      errors: [],
    });
    expect(loadNotes(dir).map(({ conversationId }) => conversationId)).toEqual(["claude:valid"]);
    expect(await run()).toMatchObject({ read: 0, groupingPending: false, errors: [] });
  });

  test("reads every machine's conversations, keeping each leaf's positions apart", async () => {
    const { dir, remove } = temporaryDirectory("self-improvement-fleet-insights-");
    cleanups.push(remove);
    const stateDir = path.join(dir, "state");
    const board = new FakeBoard();
    const own = histories("own");
    const vps = histories("vps");
    // The same session id on both machines must stay two conversations.
    own.write("shared-id", NOW - 3 * DAY, "Use mise, not npm.");
    vps.write("shared-id", NOW - 2 * DAY, "Not npm again.");
    vps.write("other", NOW - 1 * DAY, "All fine today.");
    const leaf = leafNode("bk_vps", vps.sources);
    const failing: Omit<LeafNode, "diagnostics"> = {
      nodeId: "bk_old",
      name: "Old",
      conversations: async () => {
        throw new Error("Unknown backend command: collect_self_improvement_conversations");
      },
    };
    const calls: ModelCall[] = [];
    const run = (now: number, dryRun = false, online = true) => {
      const localVersion = "2.30.0";
      const remote = bundleData(machine("2.29.0"), "b");
      return runLoop({
        stateDir,
        data: bundleData({ ...machine(localVersion), createdAt: now }, "a"),
        board,
        dryRun,
        now: () => new Date(now),
        insights: {
          runner: fakeModel(calls),
          sources: own.sources,
          excludeDirs: [],
          leaves: online
            ? [
                leaf.node,
                failing,
                {
                  nodeId: "bk_unreadable",
                  conversations: async ({ maxSegments }) =>
                    parseLeafSelection(null, maxSegments, now),
                },
              ]
            : [],
        },
        fleet: {
          self: { nodeId: "bk_desk", name: "Desk" },
          bundles: online
            ? [{ nodeId: "bk_vps", name: "VPS", data: remote, extracted: extractSignals(remote) }]
            : [],
        },
      });
    };

    const preview = await run(NOW, true);
    expect(preview.conversations.read).toBe(3);
    expect(calls).toHaveLength(0);

    const first = await run(NOW);
    // Four machines share the 30 parts: seven each for the leaves.
    expect(leaf.asked.at(-1)).toBe(7);
    expect(first.conversationLeaves).toEqual({
      bk_vps: { state: "read", parts: 2 },
      bk_old: { state: "needs-update", parts: 0 },
      bk_unreadable: { state: "failed", parts: 0 },
    });
    expect(first.conversations).toMatchObject({ read: 3, themes: 1 });
    const notes = loadNotes(insightsDir(stateDir));
    expect(notes.map((note) => note.conversationId).sort()).toEqual([
      "@bk_vps/claude:shared-id",
      "claude:shared-id",
    ]);
    const theme = loadThemes(insightsDir(stateDir)).themes["use-mise-not-npm"]!;
    expect(Object.keys(theme.conversations)).toHaveLength(2);
    // Seen in two of the three conversations reviewed, across both machines.
    expect(first.created.map((item) => item.signature)).toEqual(["insight:use-mise-not-npm"]);
    expect(
      existsSync(path.join(leafInsightsDir(insightsDir(stateDir), "bk_vps"), "cursor.json")),
    ).toBe(true);

    const firstDigest = listDigests(stateDir).at(-1)!;
    expect(firstDigest.observedHours.insights).toEqual({ "2.29.0": 2, "2.30.0": 1 });
    expect(firstDigest.signals.find(({ source }) => source === "insights")?.versions).toEqual({
      "2.29.0": { count: 1 },
      "2.30.0": { count: 1 },
    });
    await run(NOW + 2 * HOUR, false, false);
    const offlineDigest = listDigests(stateDir).at(-1)!;
    expect(offlineDigest.observedHours.insights).toEqual(firstDigest.observedHours.insights);
    expect(offlineDigest.signals.find(({ source }) => source === "insights")?.versions).toEqual(
      firstDigest.signals.find(({ source }) => source === "insights")?.versions,
    );

    // Nothing new anywhere: no model calls, and the leaf sends nothing again.
    calls.length = 0;
    const second = await run(NOW + 3 * HOUR);
    expect(second.conversations.read).toBe(0);
    expect(calls).toHaveLength(0);
    expect(second.conversationLeaves?.bk_vps).toEqual({ state: "read", parts: 0 });
  });
});
