import { describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSubagentMessages, listSubagents } from "@anthropic-ai/claude-agent-sdk";
import { normalizePersistedSessionMessages } from "./session-manager-messages.js";
import { MAX_SUBAGENT_PARTS_PER_CALL } from "./session-manager-prompt-stream.js";
import {
  MAX_REHYDRATED_PARTS_PER_CALL,
  MAX_REHYDRATED_SUBAGENTS,
  rehydrateSubagentParts,
} from "./session-manager-subagent-rehydration.js";

type Record_ = {
  type: "user" | "assistant";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
};

const assistant = (
  uuid: string,
  content: unknown[],
  parent: string | null = null,
  apiId = `msg_${uuid}`,
): Record_ => ({
  type: "assistant",
  uuid,
  session_id: "sdk-1",
  message: { id: apiId, role: "assistant", model: "claude-test", content },
  parent_tool_use_id: parent,
});
const toolResult = (uuid: string, toolUseId: string, text: string, parent: string | null = null) =>
  ({
    type: "user",
    uuid,
    session_id: "sdk-1",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    },
    parent_tool_use_id: parent,
  }) satisfies Record_;

/** A root turn that started one subagent with the `Agent` tool. */
function rootTranscript() {
  return normalizePersistedSessionMessages([
    {
      type: "user",
      uuid: "u-1",
      session_id: "sdk-1",
      message: { role: "user", content: "Survey the repository" },
      parent_tool_use_id: null,
    },
    assistant("a-1", [
      {
        type: "tool_use",
        id: "toolu_agent",
        name: "Agent",
        input: { description: "Survey", prompt: "Look around" },
      },
    ]),
    toolResult("u-2", "toolu_agent", "Survey finished"),
  ]).messages;
}

function subagent(parent: string, prefix: string): Record_[] {
  return [
    {
      type: "user",
      uuid: `${prefix}-u0`,
      session_id: "sdk-1",
      message: { role: "user", content: "Look around" },
      parent_tool_use_id: parent,
    },
    assistant(
      `${prefix}-a1`,
      [
        { type: "text", text: `${prefix} is reading` },
        { type: "tool_use", id: `${prefix}-read`, name: "Read", input: { file_path: "/a" } },
      ],
      parent,
    ),
    toolResult(`${prefix}-u1`, `${prefix}-read`, "file body", parent),
  ];
}

describe("rehydrateSubagentParts", () => {
  test("the pinned SDK reads the sidecar toolUseId and rehydrates its actual filesystem transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-subagent-sdk-"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
    try {
      const dir = join(root, "workspace");
      const sessionId = randomUUID();
      const project = join(root, "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
      const agents = join(project, sessionId, "subagents");
      await mkdir(agents, { recursive: true });
      await writeFile(
        join(project, `${sessionId}.jsonl`),
        JSON.stringify({
          type: "user",
          uuid: randomUUID(),
          parentUuid: null,
          sessionId,
          cwd: dir,
          message: { role: "user", content: "Survey the repository" },
        }) + "\n",
      );
      const first = randomUUID();
      const second = randomUUID();
      const rows = [
        {
          type: "user",
          uuid: first,
          parentUuid: null,
          sessionId,
          isSidechain: true,
          message: { role: "user", content: "Look around" },
        },
        {
          type: "assistant",
          uuid: second,
          parentUuid: first,
          sessionId,
          isSidechain: true,
          message: {
            id: "msg_fixture",
            role: "assistant",
            model: "claude-test",
            content: [{ type: "text", text: "SDK sidecar detail" }],
          },
        },
      ];
      await writeFile(
        join(agents, "agent-fixture.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      // This is the pinned SDK's on-disk field, distinct from the returned field.
      await writeFile(
        join(agents, "agent-fixture.meta.json"),
        JSON.stringify({ toolUseId: "toolu_agent" }),
      );
      expect(await listSubagents(sessionId, { dir })).toEqual(["fixture"]);
      const records = await getSubagentMessages(sessionId, "fixture", { dir });
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.parent_tool_use_id === "toolu_agent")).toBe(true);
      const messages = rootTranscript();
      await rehydrateSubagentParts(
        { listSubagents, getSubagentMessages },
        sessionId,
        dir,
        messages,
      );
      expect(messages.flatMap((message) => message.parts)).toContainEqual(
        expect.objectContaining({
          content: "SDK sidecar detail",
          parentTaskUseId: "toolu_agent",
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("keeps the live stream's per-call bound", () => {
    expect(MAX_REHYDRATED_PARTS_PER_CALL).toBe(MAX_SUBAGENT_PARTS_PER_CALL);
  });

  test("puts a subagent's steps back inside the row holding its call", async () => {
    const messages = rootTranscript();
    const getSubagentMessages = mock(async () => subagent("toolu_agent", "sub"));
    await rehydrateSubagentParts(
      { listSubagents: async () => ["agent-1"], getSubagentMessages },
      "sdk-1",
      "/workspace",
      messages,
    );

    expect(getSubagentMessages).toHaveBeenCalledWith("sdk-1", "agent-1", { dir: "/workspace" });
    const row = messages.find((message) =>
      message.parts.some((part) => part.toolUseId === "toolu_agent"),
    )!;
    const children = row.parts.filter((part) => part.parentTaskUseId === "toolu_agent");
    expect(children.map((part) => part.type)).toEqual(["text", "tool-invocation"]);
    expect(children[0]?.content).toBe("sub is reading");
    expect(children[1]).toMatchObject({ toolUseId: "sub-read", toolName: "Read" });
    // The parent's prompt to the subagent is already on the call, not a step.
    expect(row.parts.some((part) => part.content === "Look around")).toBe(false);
  });

  test("follows a nested subagent into its parent's parts", async () => {
    const messages = rootTranscript();
    const outer = subagent("toolu_agent", "outer");
    outer.splice(
      2,
      0,
      assistant(
        "outer-a2",
        [{ type: "tool_use", id: "toolu_inner", name: "Agent", input: { prompt: "Dig" } }],
        "toolu_agent",
      ),
    );
    const transcripts: Record<string, Record_[]> = {
      // Listed child first: placement must not depend on listing order.
      inner: subagent("toolu_inner", "inner"),
      outer,
    };
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["inner", "outer"],
        getSubagentMessages: async (_session, agentId) => transcripts[agentId] ?? [],
      },
      "sdk-1",
      "/workspace",
      messages,
    );
    const row = messages.find((message) =>
      message.parts.some((part) => part.toolUseId === "toolu_agent"),
    )!;
    expect(row.parts.some((part) => part.parentTaskUseId === "toolu_inner")).toBe(true);
  });

  test("leaves a row that already shows its subagent alone", async () => {
    const messages = rootTranscript();
    const row = messages.find((message) =>
      message.parts.some((part) => part.toolUseId === "toolu_agent"),
    )!;
    row.parts.push({ type: "text", content: "live step", parentTaskUseId: "toolu_agent" });
    const before = row.parts.length;
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["agent-1"],
        getSubagentMessages: async () => subagent("toolu_agent", "sub"),
      },
      "sdk-1",
      "/workspace",
      messages,
    );
    expect(row.parts.length).toBe(before);
  });

  test("bounds the work and never throws", async () => {
    const messages = rootTranscript();
    const getSubagentMessages = mock(async () => {
      throw new Error("unreadable");
    });
    await rehydrateSubagentParts(
      {
        listSubagents: async () =>
          Array.from({ length: MAX_REHYDRATED_SUBAGENTS + 10 }, (_, index) => `agent-${index}`),
        getSubagentMessages,
      },
      "sdk-1",
      "/workspace",
      messages,
    );
    expect(getSubagentMessages).toHaveBeenCalledTimes(MAX_REHYDRATED_SUBAGENTS);
    await expect(
      rehydrateSubagentParts(
        {
          listSubagents: async () => {
            throw new Error("no directory");
          },
          getSubagentMessages,
        },
        "sdk-1",
        "/workspace",
        messages,
      ),
    ).resolves.toBeUndefined();
    // An SDK without the functions is the old behaviour.
    await expect(rehydrateSubagentParts({}, "sdk-1", "/workspace", messages)).resolves.toBe(
      undefined,
    );
  });

  test("keeps only the newest parts of a long subagent", async () => {
    const messages = rootTranscript();
    const records: Record_[] = Array.from({ length: MAX_REHYDRATED_PARTS_PER_CALL + 20 }, (_, i) =>
      assistant(`long-${i}`, [{ type: "text", text: `step ${i}` }], "toolu_agent"),
    );
    await rehydrateSubagentParts(
      { listSubagents: async () => ["long"], getSubagentMessages: async () => records },
      "sdk-1",
      "/workspace",
      messages,
    );
    const row = messages.find((message) =>
      message.parts.some((part) => part.toolUseId === "toolu_agent"),
    )!;
    const steps = row.parts.filter((part) => part.parentTaskUseId === "toolu_agent");
    expect(steps).toHaveLength(MAX_REHYDRATED_PARTS_PER_CALL);
    expect(steps.at(-1)?.content).toBe(`step ${MAX_REHYDRATED_PARTS_PER_CALL + 19}`);
  });
});
