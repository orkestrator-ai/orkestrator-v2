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
  ownSubagentRecords,
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

  test("labels the call with the model its subagent's responses reported", async () => {
    const messages = rootTranscript();
    const call = () =>
      messages.flatMap((message) => message.parts).find((part) => part.toolUseId === "toolu_agent");
    expect(call()?.subagentModelId).toBeUndefined();
    await rehydrateSubagentParts(
      {
        listSubagents: mock(async () => ["agent-1"]),
        getSubagentMessages: mock(async () => subagent("toolu_agent", "one")),
      },
      "sdk-1",
      "/w",
      messages,
    );
    expect(call()?.subagentModelId).toBe("claude-test");
  });

  test.each([
    ["<synthetic>", undefined],
    [undefined, "<synthetic>"],
    [null, ""],
  ])("uses the latest real model before trailing invalid models %p and %p", async (first, last) => {
    const messages = rootTranscript();
    const response = (id: string, model: unknown): Record_ => ({
      ...assistant(id, [{ type: "text", text: id }], "toolu_agent"),
      message: { role: "assistant", model, content: [{ type: "text", text: id }] },
    });
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["agent-1"],
        getSubagentMessages: async () => [
          response("old", "claude-old"),
          response("new", "  claude-new  "),
          response("invalid-1", first),
          response("invalid-2", last),
          // A user record cannot attribute the child, even if it carries a model.
          { ...response("user", "claude-user"), type: "user" },
        ],
      },
      "sdk-1",
      "/w",
      messages,
    );
    expect(
      messages.flatMap((message) => message.parts).find((part) => part.toolUseId === "toolu_agent")
        ?.subagentModelId,
    ).toBe("claude-new");
  });

  test("preserves an existing call model when the rollout reports another", async () => {
    const messages = rootTranscript();
    const call = messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "toolu_agent")!;
    call.subagentModelId = "claude-live";
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["agent-1"],
        getSubagentMessages: async () => subagent("toolu_agent", "sub"),
      },
      "sdk-1",
      "/w",
      messages,
    );
    expect(call.subagentModelId).toBe("claude-live");
    expect(
      messages.flatMap((message) => message.parts).find((part) => part.toolUseId === "toolu_agent")
        ?.subagentModelId,
    ).toBe("claude-live");
  });

  test("leaves attribution absent when every response is synthetic or missing a model", async () => {
    const messages = rootTranscript();
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["agent-1"],
        getSubagentMessages: async () =>
          ["<synthetic>", undefined].map((model, index) => ({
            ...assistant(`invalid-${index}`, [], "toolu_agent"),
            message: { role: "assistant", model, content: [] },
          })),
      },
      "sdk-1",
      "/w",
      messages,
    );
    expect(
      messages.flatMap((message) => message.parts).find((part) => part.toolUseId === "toolu_agent")
        ?.subagentModelId,
    ).toBeUndefined();
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
    const inner = subagent("toolu_inner", "inner").map((record) =>
      record.type === "assistant"
        ? { ...record, message: { ...(record.message as object), model: "claude-inner" } }
        : record,
    );
    const transcripts: Record<string, Record_[]> = {
      // Listed child first: placement must not depend on listing order.
      inner,
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
    expect(row.parts.find((part) => part.toolUseId === "toolu_agent")?.subagentModelId).toBe(
      "claude-test",
    );
    expect(row.parts.find((part) => part.toolUseId === "toolu_inner")?.subagentModelId).toBe(
      "claude-inner",
    );
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
    expect(row.parts.find((part) => part.toolUseId === "toolu_agent")?.subagentModelId).toBe(
      "claude-test",
    );
    expect(row.parts.at(-1)).toMatchObject({
      content: "live step",
      parentTaskUseId: "toolu_agent",
    });
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

/*
 * To-do 8303 (retired). A background worker launched three forks in one
 * response. The CLI (2.1.319) writes the worker's own history into each fork's
 * transcript ahead of the fork's prompt, so a later sibling's file holds the
 * earlier siblings' launch calls without their results. Shapes follow
 * `buildForkedMessages`; every text is a placeholder.
 */
const WORKER = "toolu_worker";
const FORKS = ["toolu_fork_a", "toolu_fork_b", "toolu_fork_c"] as const;

function forkLaunch(id: string): Record_ {
  return assistant(
    `w-${id}`,
    [{ type: "tool_use", id, name: "Agent", input: { subagent_type: "fork", description: id } }],
    WORKER,
    "msg_worker_batch",
  );
}

/** A root turn that started the background worker. */
function rootWithWorker() {
  return normalizePersistedSessionMessages([
    {
      type: "user",
      uuid: "u-1",
      session_id: "sdk-1",
      message: { role: "user", content: "Fix the flakes" },
      parent_tool_use_id: null,
    },
    assistant("a-1", [
      {
        type: "tool_use",
        id: WORKER,
        name: "Agent",
        input: { description: "Worker", prompt: "Split it", run_in_background: true },
      },
    ]),
    toolResult("u-2", WORKER, "Async agent launched"),
  ]).messages;
}

/** The worker's own transcript: a note, then the three launches and their results. */
function workerTranscript(): Record_[] {
  return [
    {
      type: "user",
      uuid: "w-u0",
      session_id: "sdk-1",
      message: { role: "user", content: "Split it" },
      parent_tool_use_id: WORKER,
    },
    assistant("w-a0", [{ type: "text", text: "worker plans" }], WORKER),
    ...FORKS.map(forkLaunch),
    ...FORKS.map((id) => toolResult(`w-r-${id}`, id, "Async agent launched", WORKER)),
  ];
}

/** A fork's transcript: inherited history, its own prompt, then its own work. */
function forkTranscript(index: number): Record_[] {
  const own = FORKS[index]!;
  const stamp = (record: Record_): Record_ => ({ ...record, parent_tool_use_id: own });
  const inherited = [
    ...workerTranscript().slice(0, 2),
    // Earlier siblings' launches were already in the worker's history; their
    // results were not.
    ...FORKS.slice(0, index).map(forkLaunch),
  ].map(stamp);
  return [
    ...inherited,
    stamp({ ...forkLaunch(own), uuid: `clone-${own}` }),
    {
      type: "user",
      uuid: `prompt-${own}`,
      session_id: "sdk-1",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: own,
            content: [{ type: "text", text: "placeholder" }],
          },
          { type: "text", text: "<fork-boilerplate>\nplaceholder directive" },
        ],
      },
      parent_tool_use_id: own,
    },
    assistant(
      `${own}-a1`,
      [
        { type: "text", text: `${own} works` },
        { type: "tool_use", id: `${own}-read`, name: "Read", input: { file_path: "/a" } },
      ],
      own,
    ),
    toolResult(`${own}-u1`, `${own}-read`, "file body", own),
    assistant(`${own}-a2`, [{ type: "text", text: `${own} done` }], own),
  ];
}

describe("forks started from a subagent (to-do 8303, retired)", () => {
  const transcripts: Record<string, Record_[]> = {
    // Forks listed first: placement must not depend on listing order.
    "fork-c": forkTranscript(2),
    "fork-b": forkTranscript(1),
    "fork-a": forkTranscript(0),
    worker: workerTranscript(),
  };

  async function rehydrated() {
    const messages = rootWithWorker();
    await rehydrateSubagentParts(
      {
        listSubagents: async () => Object.keys(transcripts),
        getSubagentMessages: async (_session, agentId) => transcripts[agentId] ?? [],
      },
      "sdk-1",
      "/workspace",
      messages,
    );
    return messages.flatMap((message) => message.parts);
  }

  test("every fork launch is one settled card, not a pending copy per later sibling", async () => {
    const parts = await rehydrated();
    for (const fork of FORKS) {
      const launches = parts.filter((part) => part.toolUseId === fork);
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ toolName: "Agent", toolState: "success" });
    }
    expect(
      parts.filter((part) => part.type === "tool-invocation" && part.toolState === "pending"),
    ).toEqual([]);
  });

  test("a fork keeps only its own steps, not the history it inherited", async () => {
    const parts = await rehydrated();
    for (const fork of FORKS) {
      expect(
        parts
          .filter((part) => part.parentTaskUseId === fork)
          .map((part) => part.toolUseId ?? part.content),
      ).toEqual([`${fork} works`, `${fork}-read`, `${fork} done`]);
    }
    // The worker's note is shown once, as the worker's.
    expect(parts.filter((part) => part.content === "worker plans")).toHaveLength(1);
  });

  test("a subagent that is not a fork keeps every record", () => {
    const records = workerTranscript();
    expect(ownSubagentRecords(records)).toBe(records);
    expect(ownSubagentRecords(forkTranscript(1)).map((record) => record.uuid)).toEqual([
      "toolu_fork_b-a1",
      "toolu_fork_b-u1",
      "toolu_fork_b-a2",
    ]);
  });

  test("the pinned SDK returns a fork's inherited history as the fork's own records", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-fork-sdk-"));
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
          message: { role: "user", content: "Fix the flakes" },
        }) + "\n",
      );
      let parentUuid: string | null = null;
      const rows = forkTranscript(2).map(({ type, message }) => {
        const uuid = randomUUID();
        const row = { type, uuid, parentUuid, sessionId, isSidechain: true, message };
        parentUuid = uuid;
        return row;
      });
      await writeFile(
        join(agents, "agent-forkc.jsonl"),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
      );
      await writeFile(
        join(agents, "agent-forkc.meta.json"),
        JSON.stringify({ toolUseId: FORKS[2] }),
      );
      const records = await getSubagentMessages(sessionId, "forkc", { dir });
      // The premise of the fix: the copies come back stamped as the fork's.
      const copied = records.filter((record) => {
        const content = (record.message as { content?: unknown }).content;
        return (
          Array.isArray(content) &&
          content.some((block) => (block as { id?: unknown }).id === FORKS[0])
        );
      });
      expect(copied.length).toBeGreaterThan(0);
      expect(copied.every((record) => record.parent_tool_use_id === FORKS[2])).toBe(true);

      const messages = rootWithWorker();
      await rehydrateSubagentParts(
        {
          listSubagents: async () => ["worker", "forkc"],
          getSubagentMessages: async (session, agentId, options) =>
            agentId === "worker"
              ? workerTranscript()
              : getSubagentMessages(session, agentId, options),
        },
        sessionId,
        dir,
        messages,
      );
      const parts = messages.flatMap((message) => message.parts);
      for (const fork of FORKS) {
        expect(parts.filter((part) => part.toolUseId === fork)).toHaveLength(1);
      }
      expect(parts.filter((part) => part.parentTaskUseId === FORKS[2]).at(-1)?.content).toBe(
        `${FORKS[2]} done`,
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a copied call is dropped even without the fork prompt marker", async () => {
    const messages = rootWithWorker();
    const unmarked = forkTranscript(2).filter((record) => !record.uuid.startsWith("prompt-"));
    await rehydrateSubagentParts(
      {
        listSubagents: async () => ["worker", "fork-c"],
        getSubagentMessages: async (_session, agentId) =>
          agentId === "worker" ? workerTranscript() : unmarked,
      },
      "sdk-1",
      "/workspace",
      messages,
    );
    const parts = messages.flatMap((message) => message.parts);
    for (const fork of FORKS) {
      expect(parts.filter((part) => part.toolUseId === fork)).toHaveLength(1);
    }
  });
});
