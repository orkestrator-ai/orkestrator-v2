import { describe, expect, test } from "bun:test";
import { withoutStagedOpenCode2Revert, openCode2UndoTarget } from "./revert.js";
import {
  openCode2ExecutionProfiles,
  openCode2ResumeEntries,
  openCode2ResumeSessionId,
  openCode2SessionDetails,
  openCode2TodoCount,
} from "./sessions.js";
import type { OpenCode2Message } from "./types.js";

describe("2.x session helpers", () => {
  test("only primary, visible agents are execution profiles", () => {
    expect(
      openCode2ExecutionProfiles([
        { id: "build", name: "Build", mode: "primary", description: "Default" },
        { id: "plan", name: "Plan", mode: "primary", model: { providerID: "p", id: "m" } },
        { id: "general", name: "General", mode: "subagent" },
        { id: "title", name: "Title", mode: "primary", hidden: true },
      ]),
    ).toEqual([
      { id: "build", label: "Build", description: "Default" },
      { id: "plan", label: "Plan", modelId: "p/m" },
    ]);
  });

  test("session details carry the model, its variant, the agent and the title", () => {
    expect(
      openCode2SessionDetails({
        id: "ses_1",
        model: { providerID: "fixture", id: "fixture", variant: "default" },
        agent: "plan",
        title: "  Named  ",
        time: { created: 1, archived: 2 },
      }),
    ).toEqual({
      modelId: "fixture/fixture",
      reasoningId: "default",
      agent: "plan",
      title: "Named",
      archived: true,
    });
  });

  test("resume entries name their line in the id", () => {
    const entries = openCode2ResumeEntries([
      { id: "ses_a", title: "A", time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 } },
      { id: "ses_b", fork: { sessionID: "ses_a" }, time: { created: 1, archived: 5 } },
      { id: "not-a-session" },
    ]);
    expect(entries).toEqual([
      {
        sessionId: "opencode2:ses_a",
        title: "A",
        createdAt: new Date(1_700_000_000_000).toISOString(),
        updatedAt: new Date(1_700_000_001_000).toISOString(),
      },
      {
        sessionId: "opencode2:ses_b",
        createdAt: new Date(1).toISOString(),
        parentId: "opencode2:ses_a",
        archived: true,
      },
    ]);
    expect(openCode2ResumeSessionId("opencode2:ses_a")).toBe("ses_a");
    expect(openCode2ResumeSessionId("ses_a")).toBeUndefined();
    expect(openCode2ResumeSessionId("opencode2:../x")).toBeUndefined();
  });

  test("the to-do count is the newest todowrite list", () => {
    const rows = [
      {
        id: "msg_1",
        type: "assistant",
        content: [{ type: "tool", name: "todowrite", state: { input: { todos: [{}, {}, {}] } } }],
      },
      {
        id: "msg_2",
        type: "assistant",
        content: [
          { type: "text", text: "x" },
          { type: "tool", name: "todowrite", state: { input: { todos: [{}] } } },
        ],
      },
    ] as unknown as OpenCode2Message[];
    expect(openCode2TodoCount(rows)).toBe(1);
    expect(openCode2TodoCount(rows.slice(0, 1))).toBe(3);
    expect(openCode2TodoCount([])).toBeUndefined();
  });
});

describe("staged revert", () => {
  const rows = [
    { id: "msg_a", type: "user" },
    { id: "msg_b", type: "assistant" },
    { id: "msg_c", type: "user" },
    { id: "msg_d", type: "assistant" },
  ] as unknown as OpenCode2Message[];

  test("hides the boundary row and everything after it, by position", () => {
    const marker = { messageId: "msg_c" };
    expect(withoutStagedOpenCode2Revert(rows, marker, { complete: true }).map((r) => r.id)).toEqual(
      ["msg_a", "msg_b"],
    );
    // Forked rows end in _1 … _10, which do not sort: the cut never compares ids.
    const forked = [{ id: "msg_x_9" }, { id: "msg_x_10" }, { id: "msg_x_11" }];
    expect(
      withoutStagedOpenCode2Revert(forked, { messageId: "msg_x_10" }, { complete: true }),
    ).toEqual([{ id: "msg_x_9" }]);
    // A window that began after the boundary is covered whole; a full history is not.
    expect(withoutStagedOpenCode2Revert(rows, { messageId: "msg_0" }, { complete: false })).toEqual(
      [],
    );
    expect(withoutStagedOpenCode2Revert(rows, { messageId: "msg_0" }, { complete: true })).toEqual(
      rows,
    );
  });

  test("a bare undo takes back the newest user row still showing", () => {
    expect(openCode2UndoTarget(rows, undefined, { complete: true })).toBe("msg_c");
    expect(openCode2UndoTarget(rows, { messageId: "msg_c" }, { complete: true })).toBe("msg_a");
    expect(openCode2UndoTarget(rows, { messageId: "msg_a" }, { complete: true })).toBeUndefined();
  });
});
