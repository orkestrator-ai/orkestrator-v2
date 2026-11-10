import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { runLoop } from "../loop.js";
import {
  insightsDir,
  loadThemes,
  type Note,
  notesFor,
  readConversationsByVersion,
  type ThemeStore,
  themeSignals,
  updateThemes,
} from "./analyze.js";
import {
  claudeArgs,
  type ModelCall,
  type ModelRunner,
  NOTES_MODEL,
  parseClaudeResult,
  THEMES_MODEL,
} from "./model.js";
import { cursorAfter, type InsightCursor, type Segment } from "./prepare.js";
import { loadLedger } from "../ledger.js";
import { FakeBoard } from "../testing/fake-board.js";
import {
  bundleData,
  DAY,
  type EssentialLine,
  type FixtureBundle,
  HOUR,
  temporaryDirectory,
} from "../testing/fixtures.js";
import { claudeJsonl, writeTranscript } from "../testing/transcript-fixtures.js";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const CWD = "/home/someone/orkestrator-v2/workspaces/orkestrator-v2-20261109-175407-894d9e3cdfc3";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("the Claude Code runner", () => {
  test("runs without tools, MCP, slash commands, settings or a saved session", () => {
    const args = claudeArgs({
      model: NOTES_MODEL,
      system: "s",
      prompt: "p",
      schema: { type: "object" },
    });
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "claude-sonnet-5-5"]);
    for (const flag of [
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence",
    ]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    // The conversation goes on stdin, never in an argument.
    expect(args).not.toContain("p");
  });

  test("reads the structured output and the cost, and refuses an error or a missing answer", () => {
    expect(
      parseClaudeResult(
        JSON.stringify({
          type: "result",
          subtype: "success",
          is_error: false,
          structured_output: { a: 1 },
          total_cost_usd: 0.25,
        }),
      ),
    ).toEqual({ output: { a: 1 }, costUsd: 0.25 });
    expect(() =>
      parseClaudeResult(JSON.stringify({ subtype: "error_max_turns", is_error: true })),
    ).toThrow(/error_max_turns/);
    expect(() =>
      parseClaudeResult(JSON.stringify({ subtype: "success", is_error: false })),
    ).toThrow(/no structured/);
    expect(() => parseClaudeResult("not json")).toThrow(/JSON/);
  });
});

const SEGMENT: Segment = {
  conversationId: "claude:abc",
  provider: "claude",
  project: "orkestrator-v2",
  startedAt: NOW - 2 * HOUR,
  lastAt: NOW - HOUR,
  from: 0,
  to: 6,
  file: "/x/abc.jsonl",
  key: "0-6",
  text: "conversation text",
  typedMessages: 2,
};

function fixed<T>(output: T, calls: ModelCall[] = []): ModelRunner {
  return (async (call: ModelCall) => {
    calls.push(call);
    return { output, costUsd: 0.1 };
  }) as ModelRunner;
}

describe("notes and themes", () => {
  test("turns a model answer into bounded notes and drops unknown kinds", async () => {
    const calls: ModelCall[] = [];
    const { notes, costUsd } = await notesFor(
      SEGMENT,
      fixed(
        {
          notes: [
            {
              kind: "repeated-instruction",
              area: "package manager",
              summary: "Told to use mise again.",
              quote: "use mise",
              severity: 2,
              fixWhere: "instructions",
            },
            {
              kind: "made-up",
              area: "x",
              summary: "y",
              quote: "",
              severity: 1,
              fixWhere: "orkestrator",
            },
          ],
        },
        calls,
      ),
    );
    expect(calls[0]).toMatchObject({ model: NOTES_MODEL, prompt: "conversation text" });
    expect(costUsd).toBe(0.1);
    expect(notes).toEqual([
      {
        id: "claude:abc#0-6#0",
        conversationId: "claude:abc",
        provider: "claude",
        project: "orkestrator-v2",
        at: NOW - HOUR,
        kind: "repeated-instruction",
        area: "package manager",
        summary: "Told to use mise again.",
        quote: "use mise",
        severity: 2,
        fixWhere: "instructions",
      },
    ]);
  });

  const note = (id: string, conversationId: string, at: number): Note => ({
    id,
    conversationId,
    provider: "claude",
    project: "orkestrator-v2",
    at,
    kind: "repeated-instruction",
    area: "package manager",
    summary: "Told to use mise.",
    quote: "use mise",
    severity: 2,
    fixWhere: "instructions",
  });

  test("merges a theme's conversations across runs and ignores note ids it was not given", async () => {
    const store: ThemeStore = { schemaVersion: 1, themes: {} };
    const theme = (noteIds: string[]) => ({
      themes: [
        {
          slug: "use-mise-not-npm",
          title: "Agents keep reaching for npm",
          kind: "repeated-instruction",
          fixWhere: "instructions",
          summary: "s",
          suggestion: "Add a rule.",
          acceptance: "No reminders needed.",
          severity: 2,
          noteIds,
        },
      ],
    });
    const calls: ModelCall[] = [];
    await updateThemes(
      store,
      [note("n1", "c1", NOW - DAY)],
      fixed(theme(["n1", "invented"]), calls),
      NOW,
      () => null,
    );
    expect(calls[0]!.model).toBe(THEMES_MODEL);
    expect(Object.keys(store.themes["use-mise-not-npm"]!.conversations)).toEqual(["c1"]);
    await updateThemes(
      store,
      [note("n1", "c1", NOW - DAY), note("n2", "c2", NOW - HOUR)],
      fixed(theme(["n2"])),
      NOW,
      () => null,
    );
    expect(Object.keys(store.themes["use-mise-not-npm"]!.conversations).sort()).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("a theme's measure is its share of the conversations read, split by app version", () => {
    const store: ThemeStore = {
      schemaVersion: 1,
      themes: {
        "use-mise-not-npm": {
          slug: "use-mise-not-npm",
          title: "Agents keep reaching for npm",
          kind: "repeated-instruction",
          fixWhere: "instructions",
          summary: "",
          suggestion: "",
          acceptance: "",
          severity: 2,
          examples: [],
          conversations: {
            c1: { at: NOW - 3 * DAY, project: "a" },
            c2: { at: NOW - DAY, project: "b" },
          },
          updatedAt: NOW,
        },
      },
    };
    const versionAt = (at: number) => (at < NOW - 2 * DAY ? "2.30.0" : "2.31.0");
    const [signal] = themeSignals(store, { "2.30.0": 4, "2.31.0": 6 }, versionAt, NOW);
    expect(signal).toMatchObject({
      signature: "insight:use-mise-not-npm",
      category: "insight",
      source: "insights",
      count: 2,
      activeDays: 2,
      measure: { kind: "rate", unit: "of conversations", value: 0.2 },
      versions: { "2.30.0": { count: 1 }, "2.31.0": { count: 1 } },
    });
    expect(signal!.evidence).toMatchObject({
      conversations: 2,
      projects: 2,
      fixWhere: "instructions",
    });
  });
});

describe("a run with the conversation review", () => {
  function starting(at: number, version: string): EssentialLine {
    return { at, level: "info", area: "backend", event: "starting", fields: { version } };
  }

  /** A model that notes "npm" whenever a person mentions it, and groups those notes into one theme. */
  function fakeModel(calls: ModelCall[]): ModelRunner {
    return (async (call: ModelCall) => {
      calls.push(call);
      if (call.model === NOTES_MODEL) {
        const npm = /PERSON: .*npm/.test(call.prompt);
        const slow = /PERSON: .*slow/.test(call.prompt);
        return {
          output: {
            notes: [
              ...(npm
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
                : []),
              ...(slow
                ? [
                    {
                      kind: "slow-or-stuck",
                      area: "pipeline",
                      summary: "Pipeline felt slow.",
                      quote: "so slow",
                      severity: 1,
                      fixWhere: "orkestrator",
                    },
                  ]
                : []),
            ],
          },
          costUsd: 0.05,
        };
      }
      const ids = (pattern: RegExp) =>
        call.prompt
          .split("\n")
          .filter((line) => pattern.test(line))
          .map((line) => line.split(" | ")[0]!);
      const themes = [
        {
          slug: "use-mise-not-npm",
          title: "Agents keep reaching for npm",
          kind: "repeated-instruction",
          fixWhere: "instructions",
          summary: "People keep telling agents to use mise.",
          suggestion: "Add a rule to AGENTS.md.",
          acceptance: "Nobody has to say it.",
          severity: 2,
          noteIds: ids(/package manager/),
        },
        {
          slug: "slow-pipelines",
          title: "Pipelines feel slow",
          kind: "slow-or-stuck",
          fixWhere: "orkestrator",
          summary: "s",
          suggestion: "s",
          acceptance: "a",
          severity: 1,
          noteIds: ids(/\| pipeline \|/),
        },
        {
          slug: "third-theme",
          title: "A third theme",
          kind: "confusion",
          fixWhere: "unclear",
          summary: "s",
          suggestion: "s",
          acceptance: "a",
          severity: 3,
          noteIds: ids(/package manager/).slice(0, 1),
        },
      ].filter((theme) => theme.noteIds.length > 0);
      return { output: { themes }, costUsd: 0.5 };
    }) as ModelRunner;
  }

  test("files insight tickets labelled insight, at most two a day, then verifies the fix on the newer version", async () => {
    const { dir, remove } = temporaryDirectory("improvement-insight-loop-");
    cleanups.push(remove);
    const claudeDir = path.join(dir, "claude", "projects", "-p");
    const sources = {
      claudeProjectDirs: [path.join(dir, "claude", "projects")],
      codexSessionDirs: [],
    };
    const board = new FakeBoard();
    let bundle: FixtureBundle = { createdAt: NOW };
    const calls: ModelCall[] = [];
    const conversation = (id: string, at: number, text: string) =>
      writeTranscript(
        path.join(claudeDir, `${id}.jsonl`),
        claudeJsonl(id, CWD, [
          { user: text, at },
          { assistant: "OK.", at: at + 1000 },
        ]),
        at + 2000,
      );
    const loop = (now: number, dryRun = false) =>
      runLoop({
        stateDir: path.join(dir, "state"),
        data: bundleData(bundle),
        board,
        now: () => new Date(now),
        dryRun,
        insights: { runner: fakeModel(calls), sources, excludeDirs: [] },
      });

    // Five days on 2.30.0: npm comes up in three conversations, slowness in two.
    const start = NOW - 10 * DAY;
    bundle = {
      createdAt: start + 5 * DAY,
      appVersion: "2.30.0",
      essential: [starting(start, "2.30.0")],
    };
    conversation("a", start + 1 * DAY, "Use mise, not npm.");
    conversation("b", start + 2 * DAY, "Again: not npm. And this is so slow.");
    conversation("c", start + 3 * DAY, "npm again?");
    conversation("d", start + 4 * DAY, "The pipeline is so slow.");

    const dry = await loop(start + 5 * DAY, true);
    expect(dry.conversations.read).toBe(4);
    expect(calls).toHaveLength(0);

    const first = await loop(start + 5 * DAY);
    expect(first.conversations).toMatchObject({ read: 4, themes: 3 });
    expect(first.created.map((item) => item.title).sort()).toEqual([
      "[insight] A third theme",
      "[insight] Agents keep reaching for npm",
    ]);
    expect(first.conversations.heldForTomorrow).toBe(1);
    const ticket = board.ticketFor("insight:use-mise-not-npm");
    expect(ticket.labels).toEqual(["insight"]);
    expect(board.labels).toEqual(new Set(["insight", "improvement"]));
    expect(ticket.description).toContain("## Where to fix");
    expect(ticket.description).toContain('You wrote: "not npm"');
    expect(ticket.description).not.toContain("OK.");

    // Nothing new to read: no model calls, nothing filed twice.
    calls.length = 0;
    const second = await loop(start + 5 * DAY + HOUR);
    expect(calls).toHaveLength(0);
    expect(second.created).toEqual([]);

    // The rule ships in 2.31.0; ten conversations later npm never comes up.
    ticket.status = "done";
    await loop(start + 5 * DAY + 2 * HOUR);
    expect(loadLedger(path.join(dir, "state")).entries["insight:use-mise-not-npm"]).toMatchObject({
      status: "fixed",
      fixedAfter: "2.30.0",
    });
    const later = start + 6 * DAY;
    bundle = {
      createdAt: NOW,
      appVersion: "2.31.0",
      essential: [starting(start, "2.30.0"), starting(later - HOUR, "2.31.0")],
    };
    // Ten conversations with nothing but system messages are skipped, not
    // reviewed: they are no evidence the fix worked.
    for (let index = 0; index < 10; index += 1) {
      const at = later + index * 6 * HOUR;
      writeTranscript(
        path.join(claudeDir, `system-${index}.jsonl`),
        claudeJsonl(`system-${index}`, CWD, [
          { user: "Background task finished", at, origin: "task-notification" },
        ]),
        at + 2000,
      );
    }
    const systemOnly = await loop(NOW - DAY);
    expect(systemOnly.verified).toEqual([]);
    expect(
      loadLedger(path.join(dir, "state")).entries["insight:use-mise-not-npm"]!.observations.at(-1)
        ?.verdict,
    ).toBe("awaiting-deploy");

    for (let index = 0; index < 10; index += 1) {
      conversation(`later-${index}`, later + index * 6 * HOUR, `Please tidy file ${index}.`);
    }
    const judged = await loop(NOW);
    expect(judged.verified.map((item) => item.signature)).toContain("insight:use-mise-not-npm");
    expect(ticket.comments.at(-1)).toContain("the fix is verified");
  });
});

describe("what counts as a reviewed conversation", () => {
  const part = (lastAt: number) => ({
    conversationId: "claude:c",
    to: 4,
    file: "/x/c.jsonl",
    lastEntryOffset: 900,
    lastAt,
    project: "p",
  });

  test("only conversations a model reviewed count, and a skipped system-only tail keeps that", () => {
    const versionAt = (at: number) => (at < NOW - DAY ? "2.30.0" : "2.31.0");
    const reviewed = cursorAfter(
      { ...part(NOW - 2 * DAY), provider: "claude", project: "p" } as unknown as Segment,
      true,
      undefined,
      NOW,
    );
    const skippedAfterReview = cursorAfter(part(NOW - HOUR), false, reviewed, NOW);
    expect(skippedAfterReview).toMatchObject({ lastAt: NOW - HOUR, reviewedAt: NOW - 2 * DAY });
    const cursor: InsightCursor = {
      schemaVersion: 1,
      conversations: {
        "claude:c": skippedAfterReview,
        "claude:system": cursorAfter(part(NOW - HOUR), false, undefined, NOW),
      },
    };
    expect(cursor.conversations["claude:system"]!.reviewedAt).toBeUndefined();
    // The reviewed one counts on the version it was reviewed on; the system-only one not at all.
    expect(readConversationsByVersion(cursor, versionAt, NOW)).toEqual({ "2.30.0": 1 });
  });
});

describe("a theme grouping that fails", () => {
  test("is retried on the next run from the saved notes, without reading the conversations again", async () => {
    const { dir, remove } = temporaryDirectory("improvement-themes-retry-");
    cleanups.push(remove);
    const stateDir = path.join(dir, "state");
    const claudeDir = path.join(dir, "claude", "projects", "-p");
    const sources = {
      claudeProjectDirs: [path.join(dir, "claude", "projects")],
      codexSessionDirs: [],
    };
    for (const [id, at, text] of [
      ["a", NOW - 3 * DAY, "Use mise, not npm."],
      ["b", NOW - 2 * DAY, "Not npm, again."],
    ] as const) {
      writeTranscript(
        path.join(claudeDir, `${id}.jsonl`),
        claudeJsonl(id, CWD, [
          { user: text, at },
          { assistant: "OK.", at: at + 1000 },
        ]),
        at + 2000,
      );
    }
    let themesFailures = 1;
    const calls: ModelCall[] = [];
    const runner = (async (call: ModelCall) => {
      if (call.model === THEMES_MODEL && themesFailures > 0) {
        themesFailures -= 1;
        calls.push(call);
        throw new Error("Claude Code exited with code 1");
      }
      calls.push(call);
      const ids = call.prompt
        .split("\n")
        .filter((line) => line.includes("package manager"))
        .map((line) => line.split(" | ")[0]!);
      return call.model === NOTES_MODEL
        ? {
            output: {
              notes: [
                {
                  kind: "repeated-instruction",
                  area: "package manager",
                  summary: "Had to say use mise.",
                  quote: "not npm",
                  severity: 2,
                  fixWhere: "instructions",
                },
              ],
            },
            costUsd: 0.05,
          }
        : {
            output: {
              themes: [
                {
                  slug: "use-mise-not-npm",
                  title: "Agents keep reaching for npm",
                  kind: "repeated-instruction",
                  fixWhere: "instructions",
                  summary: "s",
                  suggestion: "s",
                  acceptance: "a",
                  severity: 2,
                  noteIds: ids,
                },
              ],
            },
            costUsd: 0.5,
          };
    }) as ModelRunner;
    const board = new FakeBoard();
    const loop = (now: number) =>
      runLoop({
        stateDir,
        data: bundleData({ createdAt: now, appVersion: "2.30.0" }),
        board,
        now: () => new Date(now),
        insights: { runner, sources, excludeDirs: [] },
      });

    const failed = await loop(NOW);
    expect(calls.map((call) => call.model)).toEqual([NOTES_MODEL, NOTES_MODEL, THEMES_MODEL]);
    expect(failed.conversations.errors).toEqual([
      "themes: Claude Code exited with code 1 (grouped again next run)",
    ]);
    expect(failed.created).toEqual([]);
    expect(loadThemes(insightsDir(stateDir)).pendingGrouping).toBe(true);

    calls.length = 0;
    const retried = await loop(NOW + HOUR);
    expect(calls.map((call) => call.model)).toEqual([THEMES_MODEL]);
    expect(retried.conversations.errors).toEqual([]);
    expect(retried.created.map((item) => item.signature)).toEqual(["insight:use-mise-not-npm"]);
    const store = loadThemes(insightsDir(stateDir));
    expect(store.pendingGrouping).toBeUndefined();
    expect(Object.keys(store.themes["use-mise-not-npm"]!.conversations).sort()).toEqual([
      "claude:a",
      "claude:b",
    ]);

    // Grouped: nothing left to retry.
    calls.length = 0;
    await loop(NOW + 2 * HOUR);
    expect(calls).toEqual([]);
  });
});
