import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { unknownCommand } from "@orkestrator/protocol/contract/errors";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import {
  answerLeafConversations,
  answerLeafDiagnostics,
  leafConversationId,
  leafFailure,
  leafInsightsDir,
  leafOfConversation,
  MAX_LEAF_ARCHIVE_BYTES,
  parseCursor,
  parseLeafArchive,
  parseLeafSelection,
} from "./leaves.js";
import { cursorAfter, MAX_SEGMENT_CHARS } from "./insights/prepare.js";
import { HOUR, temporaryDirectory } from "./testing/fixtures.js";
import { claudeJsonl, writeTranscript } from "./testing/transcript-fixtures.js";

const NOW = Date.parse("2026-11-09T09:00:00.000Z");
const CWD = "/work/project";
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** A JSON round trip, as the answer crosses the node link. */
function overTheLink<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function leafHistories() {
  const { dir, remove } = temporaryDirectory("self-improvement-leaf-");
  cleanups.push(remove);
  const projects = path.join(dir, "claude", "projects");
  const write = (id: string, at: number, text: string, cwd = CWD) =>
    writeTranscript(
      path.join(projects, "-p", `${id}.jsonl`),
      claudeJsonl(id, cwd, [
        { user: text, at },
        { assistant: "Done.", at: at + 1000 },
      ]),
      at + 2000,
    );
  return {
    dir,
    sources: { claudeProjectDirs: [projects], codexSessionDirs: [] },
    write,
  };
}

describe("a leaf's conversations", () => {
  test("are the unread parts after the positions the command node sent, redacted", async () => {
    const leaf = leafHistories();
    leaf.write(
      "one",
      NOW - 5 * HOUR,
      "Use mise, not npm. token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    leaf.write("two", NOW - 4 * HOUR, "The pipeline is slow.");
    leaf.write("excluded", NOW - 3 * HOUR, "Inside the data directory.", "/data/dir/project");
    // Still being written: not settled yet.
    leaf.write("fresh", NOW - HOUR / 2, "Not yet.");

    const first = parseLeafSelection(
      overTheLink(
        await answerLeafConversations({
          sources: leaf.sources,
          excludeDirs: ["/data/dir"],
          cursor: undefined,
          maxSegments: 30,
          now: NOW,
        }),
      ),
      30,
    );
    expect(first.segments.map((segment) => segment.conversationId).sort()).toEqual([
      "claude:one",
      "claude:two",
    ]);
    const one = first.segments.find((segment) => segment.conversationId === "claude:one")!;
    expect(one.text).toContain("not npm");
    expect(one.text).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");

    // The command node read "one": the leaf sends only "two" next time.
    const cursor = {
      schemaVersion: 1 as const,
      conversations: { "claude:one": cursorAfter(one, true, undefined, NOW) },
    };
    const second = parseLeafSelection(
      overTheLink(
        await answerLeafConversations({
          sources: leaf.sources,
          excludeDirs: [],
          cursor: overTheLink(cursor),
          maxSegments: 1,
          now: NOW,
        }),
      ),
      1,
    );
    expect(second.segments.map((segment) => segment.conversationId)).toEqual(["claude:excluded"]);
    expect(second.waiting).toBe(1);
  });

  test("an answer is checked field by field and bounded", () => {
    const segment = {
      conversationId: "claude:one",
      provider: "claude",
      project: "p",
      startedAt: NOW - HOUR,
      lastAt: NOW,
      from: 0,
      to: 2,
      file: "/home/me/.claude/projects/-p/one.jsonl",
      key: "@0-10",
      text: "PERSON: hello",
      typedMessages: 1,
    };
    const selection = parseLeafSelection(
      {
        segments: [
          segment,
          { ...segment, conversationId: "claude:two", provider: "gemini" },
          { ...segment, conversationId: "claude:three", text: "x".repeat(MAX_SEGMENT_CHARS * 2) },
          { ...segment, conversationId: "claude:four", to: 0 },
          { ...segment, conversationId: "claude:five" },
          "not a part",
        ],
        skipped: [{ conversationId: "claude:six", to: 3, file: "/f", lastAt: NOW }, { to: 1 }],
        waiting: 2,
      },
      1,
    );
    expect(selection.segments.map((part) => part.conversationId)).toEqual(["claude:one"]);
    // Over the limit asked for: counted as waiting, not read.
    expect(selection.waiting).toBe(3);
    expect(selection.skipped.map((part) => part.conversationId)).toEqual(["claude:six"]);
    expect(parseLeafSelection(null, 30)).toEqual({ segments: [], skipped: [], waiting: 0 });
  });

  test("positions sent to a leaf keep valid entries only", () => {
    const cursor = parseCursor({
      conversations: {
        "claude:one": {
          analyzedEntries: 4,
          file: "/f",
          lastEntryOffset: 120,
          lastAt: NOW,
          project: "p",
          analyzedAt: NOW,
          reviewedAt: NOW,
        },
        "claude:two": { analyzedEntries: -1, lastAt: NOW, analyzedAt: NOW },
        "claude:three": "nonsense",
      },
    });
    expect(Object.keys(cursor.conversations)).toEqual(["claude:one"]);
    expect(cursor.conversations["claude:one"]).toMatchObject({
      lastEntryOffset: 120,
      reviewedAt: NOW,
    });
    expect(parseCursor("nonsense")).toEqual({ schemaVersion: 1, conversations: {} });
  });
});

describe("a leaf's diagnostics", () => {
  test("travel as base64 and are refused when too large", async () => {
    const archive = Buffer.from("a bundle");
    const answer = overTheLink(await answerLeafDiagnostics(async () => archive));
    expect(parseLeafArchive(answer)).toEqual(archive);
    await expect(
      answerLeafDiagnostics(async () => Buffer.alloc(MAX_LEAF_ARCHIVE_BYTES + 1)),
    ).rejects.toThrow("too large");
    expect(() => parseLeafArchive({})).toThrow("no readable diagnostics bundle");
    expect(() => parseLeafArchive({ archive: "" })).toThrow("no readable diagnostics bundle");
  });
});

describe("leaf identities", () => {
  test("a leaf's conversation ids carry its node id, and its positions a portable directory", () => {
    const id = leafConversationId("bk_leaf:1", "claude:one");
    expect(id).toBe("@bk_leaf:1/claude:one");
    expect(leafOfConversation(id)).toBe("bk_leaf:1");
    expect(leafOfConversation("claude:one")).toBeNull();
    const dir = leafInsightsDir("/state/insights", "bk_leaf:1");
    expect(path.dirname(dir)).toBe("/state/insights/nodes");
    expect(path.basename(dir)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("a leaf that predates the commands needs an update; any other failure is a failure", () => {
    expect(leafFailure(unknownCommand("collect_self_improvement_diagnostics", "system"))).toBe(
      "needs-update",
    );
    expect(
      leafFailure(
        new Error(
          `Leaf: ${unknownBackendCommandMessage("collect_self_improvement_conversations")}`,
        ),
      ),
    ).toBe("needs-update");
    expect(leafFailure(new Error("The node is not connected."))).toBe("failed");
  });
});
