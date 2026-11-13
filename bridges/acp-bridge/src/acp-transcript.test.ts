import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  BRIDGE_STARTUP_TIMEOUT_MS,
  nativeFetch,
  sharedBridge,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";
import { MAX_HISTORY_MESSAGE_IDS, MAX_MESSAGES } from "./acp-context.js";

describe("ACP bridge", () => {
  // One bridge for every test that neither restarts it nor reads its state
  // directory; each opens its own session, which the helper closes afterwards.
  // Some tests end with their turn still running, and closing then waits for
  // the agent to answer `session/cancel` (2 s by default). Nothing here asserts
  // on closing, so the wait is shortened rather than paid per test.
  const shared = sharedBridge({ ACP_CLOSE_CANCEL_WAIT_MS: "200" });

  test("does not replay history into a transcript the bridge already holds", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "reconnect-replay.log");
    await shared.agentEnv({
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_REPLAY_HISTORY: "1",
    });
    const bridge = shared;
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);
    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:Answered" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then(
        (response) => response.json(),
      ) as Promise<{
        status: string;
        messages: Array<{ role: string; content: string; parts: Array<{ type: string }> }>;
      }>;
    const before = await waitFor(readSession, (value) => value.status === "idle");
    expect(before.messages).toHaveLength(2);

    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(readSession, (value) => value.status === "error");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: created.id }),
    });
    expect(resumed.status).toBe(201);
    const resumedMeta = (await resumed.json()) as { sessionId: string };
    shared.track(resumedMeta.sessionId);
    const after = (await nativeFetch(`${bridge.base}/session/${resumedMeta.sessionId}`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      messages: Array<{ role: string; content: string; parts: Array<{ type: string }> }>;
    };
    // Replayed text and replayed tool calls are both suppressed: the agent is
    // re-describing a conversation this session already stores.
    expect(after.messages.map((message) => [message.role, message.content])).toEqual(
      before.messages.map((message) => [message.role, message.content]),
    );
    expect(after.messages.flatMap((message) => message.parts.map((part) => part.type))).toEqual(
      before.messages.flatMap((message) => message.parts.map((part) => part.type)),
    );
    expect(
      after.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "tool-invocation"),
    ).toHaveLength(0);
  });

  test("hydrates replayed history that carries no provider message ids", async () => {
    await shared.agentEnv({ FAKE_ACP_REPLAY_NO_MESSAGE_IDS: "1" });
    const bridge = shared;
    const listed = (await nativeFetch(`${bridge.base}/session/list`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as { sessions: Array<{ id: string; title?: string }> };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumed.status).toBe(201);
    const resumedMeta = (await resumed.json()) as { sessionId: string };
    shared.track(resumedMeta.sessionId);
    const session = (await nativeFetch(`${bridge.base}/session/${resumedMeta.sessionId}`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      messages: Array<{
        role: string;
        content: string;
        parts: Array<{ type: string; content: string }>;
      }>;
    };

    expect(
      session.messages.map((message) => [
        message.role,
        message.parts.map((part) => `${part.type}:${part.content}`),
      ]),
    ).toEqual([
      // Array-form content is flattened into one block rather than dropped.
      ["user", ["text:Earlier question"]],
      // A thought chunk followed by a text chunk is one assistant turn, so the
      // change of part type must not open a second message.
      ["assistant", ["thinking:Thinking first", "text:Earlier answer continued"]],
      // A whole-message update always begins a new turn.
      ["assistant", ["text:Second answer"]],
    ]);
  });

  test("bounds remembered provider message ids during a large replay", async () => {
    await shared.agentEnv({
      FAKE_ACP_REPLAY_MESSAGE_COUNT: String(Math.max(MAX_MESSAGES, MAX_HISTORY_MESSAGE_IDS) + 200),
    });
    const bridge = shared;
    const listed = (await nativeFetch(`${bridge.base}/session/list`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as { sessions: Array<{ id: string; title?: string }> };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");

    const resumed = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumed.status).toBe(201);
    const resumedMeta = (await resumed.json()) as { sessionId: string };
    shared.track(resumedMeta.sessionId);
    const session = (await nativeFetch(`${bridge.base}/session/${resumedMeta.sessionId}`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      status: string;
      baseIndex: number;
      messages: Array<{ role: string }>;
    };

    // More distinct provider message ids than either bound allows. The session
    // stays usable, the transcript stays capped, and the eviction is reported
    // through `baseIndex` rather than silently shifting the client's window.
    expect(session.status).toBe("idle");
    expect(session.messages.length).toBeLessThanOrEqual(MAX_MESSAGES);
    expect(session.baseIndex).toBeGreaterThan(0);
  });

  // The attribution has to be *stored per message*, not derived from whatever
  // the composer currently has selected. Switching models mid-session is the
  // only assertion that separates the two: a restart alone cannot, because the
  // composer restores to the same selection the messages were stamped with.
  test("keeps each assistant message on the model that produced it when the model changes", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-switch:tab-1" }),
    }).then((response) => response.json())) as { id: string };

    const readSession = (bridge: { base: string; headers: Record<string, string> }) =>
      waitFor(
        () =>
          nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then(
            (response) => response.json(),
          ) as Promise<{
            status: string;
            messages: Array<{ role: string; content: string; modelId?: string }>;
          }>,
        (value) => value.status === "idle",
      );

    // No `modelId` in the body: the turn runs on the agent's own default, and
    // that default is what the message must record.
    const firstTurn = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "DIRECT:first turn", requestId: "switch-1" }),
    });
    expect(firstTurn.status).toBe(202);
    await readSession(first);

    const secondTurn = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({
        prompt: "DIRECT:second turn",
        requestId: "switch-2",
        modelId: "gpt-5.5",
      }),
    });
    expect(secondTurn.status).toBe(202);
    // The 202 is written after the route has already set the session running,
    // so this cannot observe the previous turn's idle snapshot.
    const session = await readSession(first);

    expect(session.messages.map((message) => [message.role, message.modelId])).toEqual([
      // A user message is never attributed to a model.
      ["user", undefined],
      ["assistant", "composer-2.5"],
      ["user", undefined],
      ["assistant", "gpt-5.5"],
    ]);
    // The first reply keeps its own model even though the composer has since
    // moved on, which is what a derived-at-read-time stamp would get wrong.
    expect(session.messages[1]?.content).toBe("first turn");
    expect(session.messages[3]?.content).toBe("second turn");

    await waitFor(
      () =>
        fs.readFile(resolve(stateDirectory, "state.json"), "utf8").then(
          (contents) =>
            JSON.parse(contents) as {
              sessions: Array<{ messages: Array<{ role: string; modelId?: string }> }>;
            },
        ),
      (value) =>
        value.sessions.some(
          (persisted) =>
            persisted.messages.filter((message) => message.role === "assistant").length === 2,
        ),
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = (await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json())) as {
      messages: Array<{ role: string; modelId?: string }>;
    };
    expect(
      restored.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.modelId),
    ).toEqual(["composer-2.5", "gpt-5.5"]);
  });

  test("normalizes ACP tool calls, upserts updates, and rehydrates them after restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-1" }),
    }).then((response) => response.json())) as { id: string };

    const promptResponse = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "TOOLS: edit the file" }),
    });
    expect(promptResponse.status).toBe(202);

    const session = await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then(
          (response) => response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const assistantParts = session.messages[1]?.parts;
    expect(assistantParts?.map((part) => part.type)).toEqual([
      "thinking",
      "tool-invocation",
      "tool-invocation",
    ]);
    // The prose after the calls is the model's next response, on a row of its own.
    expect(session.messages[2]?.parts.map((part) => part.type)).toEqual(["text"]);
    expect(assistantParts?.filter((part) => part.toolUseId === "edit-1")).toHaveLength(1);
    expect(assistantParts?.[1]).toMatchObject({
      type: "tool-invocation",
      content: "Edit `src/example.ts`",
      sourcePartId: "tool:edit-1",
      sourceMessageId: expect.any(String),
      toolUseId: "edit-1",
      toolName: "edit",
      toolArgs: { path: "src/example.ts" },
      toolState: "success",
      toolTitle: "Edit `src/example.ts`",
      toolOutput: JSON.stringify({ success: true }, null, 2),
      toolDiff: {
        filePath: "src/example.ts",
        additions: 2,
        deletions: 1,
      },
    });
    const editDiff = assistantParts?.[1]?.toolDiff as Record<string, unknown> | undefined;
    expect(editDiff?.diff).toContain("-const value = 1;\n+const value = 2;\n+const ready = true;");
    // The rendered diff is what the renderer reads, so the whole-file states it
    // would never fall back to are not carried alongside it.
    expect(editDiff?.before).toBeUndefined();
    expect(editDiff?.after).toBeUndefined();
    expect(assistantParts?.[2]).toMatchObject({
      type: "tool-invocation",
      content: "Search for references",
      toolUseId: "search-1",
      toolName: "search",
      toolArgs: { pattern: "value" },
      toolState: "success",
      toolTitle: "Search for references",
      toolOutput: JSON.stringify({ totalMatches: 3 }, null, 2),
    });

    await waitFor(
      async () =>
        JSON.parse(await fs.readFile(resolve(stateDirectory, "state.json"), "utf8")) as {
          version: number;
          sessions: Array<{ messages: Array<{ parts: Array<{ toolUseId?: string }> }> }>;
        },
      (value) =>
        value.version === 3 &&
        value.sessions[0]?.messages.some((message) =>
          message.parts.some((part) => part.toolUseId === "edit-1"),
        ) === true,
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = (await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json())) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(restored.messages[1]?.parts).toEqual(assistantParts);
  });

  test("keeps Cursor's completed Task launch active until the background sub-agent ends", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-background-subagent:tab-1" }),
    }).then((response) => response.json())) as { id: string };

    expect(
      (
        await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
          method: "POST",
          headers: first.headers,
          body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT: validate" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then(
          (response) => response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.messages[1]?.parts[0]).toMatchObject({
      type: "tool-invocation",
      toolUseId: "cursor-subagent-1",
      toolName: "task",
      toolState: "success",
      agentState: "active",
      toolOutput: "Sub-agent launched.",
    });
    expect(
      await nativeFetch(`${first.base}/session/${created.id}/activity`, {
        headers: first.headers,
      }).then((response) => response.json()),
    ).toEqual({ activity: "working" });

    await stopChild(first.child);
    const restarted = await spawnBridge({ stateDirectory });
    const restored = (await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json())) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    // The background child belonged to the old Cursor process, so restart is
    // authoritative evidence that it cannot still be running.
    expect(restored.messages[1]?.parts[0]).toMatchObject({
      toolState: "success",
      agentState: "failed",
    });
    expect(
      await nativeFetch(`${restarted.base}/session/${created.id}/activity`, {
        headers: restarted.headers,
      }).then((response) => response.json()),
    ).toEqual({ activity: "idle" });
  });

  test("applies Cursor's cursor/task notification onto the matching Task launch", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASK: summarize" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-task-1" &&
              (part.toolArgs as { description?: string } | undefined)?.description ===
                "Summarize two docs",
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-task-1"),
    ).toMatchObject({
      toolName: "task",
      toolState: "success",
      agentState: "finished",
      toolArgs: {
        description: "Summarize two docs",
        prompt:
          "Read docs/development/upgrade-agents.md and docs/development/flaky-tests.md. Return one line each.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-abc123",
        durationMs: 1_240,
      },
    });
  });

  test("acknowledges a cursor/task request instead of refusing it", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "cursor-task-response.log");
    await shared.agentEnv({ FAKE_ACP_CURSOR_TASK_REQUEST_FILE: responseFile });
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-request:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKREQUEST: summarize" }),
        })
      ).status,
    ).toBe(202);

    const response = await waitFor(
      () =>
        fs
          .readFile(responseFile, "utf8")
          .then((value) => JSON.parse(value.trim()))
          .catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({
      id: 903,
      result: {},
    });
    expect(response).not.toHaveProperty("error");
    expect(response).not.toHaveProperty("result.outcome");

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              (part.toolArgs as { description?: string } | undefined)?.description ===
              "Summarize two docs",
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-task-1"),
    ).toMatchObject({
      agentState: "finished",
      toolArgs: { subagent_type: "explore" },
    });
  });

  test("keeps cursor/task launch args after a later generic Task rawInput patch", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-wipe:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKWIPE: summarize" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-wipe");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "task",
      toolState: "success",
      toolArgs: {
        description: "Summarize two docs",
        prompt: "Read docs/development/upgrade-agents.md and docs/development/flaky-tests.md.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-wipe",
        durationMs: 1_240,
      },
    });
  });

  test("stamps Cursor updateTodos from cursor/update_todos onto the matching tool call", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTODOS: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-todos-1" &&
              Array.isArray((part.toolArgs as { todos?: unknown } | undefined)?.todos),
          ),
        ),
    );
    const part = settled.messages
      .flatMap((message) => message.parts)
      .find((item) => item.toolUseId === "cursor-todos-1");
    expect(part).toMatchObject({
      toolName: "updateTodos",
      toolTitle: "Update TODOs",
      toolState: "success",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("acknowledges a cursor/update_todos request instead of refusing it", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "cursor-todos-response.log");
    await shared.agentEnv({ FAKE_ACP_CURSOR_TODOS_REQUEST_FILE: responseFile });
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-request:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTODOSREQUEST: track work" }),
        })
      ).status,
    ).toBe(202);

    const response = await waitFor(
      () =>
        fs
          .readFile(responseFile, "utf8")
          .then((value) => JSON.parse(value.trim()))
          .catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({
      id: 904,
      result: {},
    });
    expect(response).not.toHaveProperty("error");

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-todos-1" &&
              Array.isArray((part.toolArgs as { todos?: unknown } | undefined)?.todos),
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-todos-1")?.toolArgs,
    ).toMatchObject({
      merge: false,
      todos: [
        { id: "1", content: "Set up project structure", status: "completed" },
        { id: "2", content: "Add authentication", status: "in_progress" },
        { id: "3", content: "Write unit tests", status: "pending" },
      ],
    });
  });

  test("merges a later cursor/update_todos into the existing list", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-merge:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTODOSMERGE: continue" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-todos-merge-2" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 4,
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-todos-merge-2"),
    ).toMatchObject({
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "3", content: "Write unit tests", status: "pending" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ],
      },
    });
  });

  test("replaces the Cursor todo list when merge is false", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-replace:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTODOSREPLACE: reset" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-todos-replace-2" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 1,
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-todos-replace-2")?.toolArgs,
    ).toEqual({
      merge: false,
      todos: [{ id: "9", content: "Only this remains", status: "pending" }],
    });
  });

  test("merges cursor/update_todos into the list restored from persisted tool args", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-reload:tab-1" }),
    }).then((response) => response.json())) as { id: string };

    expect(
      (
        await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
          method: "POST",
          headers: first.headers,
          body: JSON.stringify({ prompt: "CURSORTODOS: track work", requestId: "todos-1" }),
        })
      ).status,
    ).toBe(202);

    await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then(
          (response) => response.json(),
        ) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    await waitFor(
      () =>
        fs.readFile(resolve(stateDirectory, "state.json"), "utf8").then(
          (contents) =>
            JSON.parse(contents) as {
              sessions: Array<{ messages: Array<{ parts: Array<Record<string, unknown>> }> }>;
            },
        ),
      (value) =>
        value.sessions.some((persisted) =>
          persisted.messages.some((message) =>
            message.parts.some(
              (part) =>
                part.toolUseId === "cursor-todos-1" &&
                Array.isArray((part.toolArgs as { todos?: unknown[] } | undefined)?.todos) &&
                (part.toolArgs as { todos: unknown[] }).todos.length === 3,
            ),
          ),
        ),
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = (await nativeFetch(`${restarted.base}/session/create`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-reload:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    expect(restored.id).toBe(created.id);

    expect(
      (
        await nativeFetch(`${restarted.base}/session/${created.id}/prompt`, {
          method: "POST",
          headers: restarted.headers,
          body: JSON.stringify({
            prompt: "CURSORTODOSRELOADMERGE: continue",
            requestId: "todos-2",
          }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${restarted.base}/session/${created.id}`, { headers: restarted.headers }).then(
          (response) => response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "cursor-todos-reload-merge" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 4,
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-todos-reload-merge")?.toolArgs,
    ).toEqual({
      merge: true,
      todos: [
        { id: "1", content: "Set up project structure", status: "completed" },
        { id: "2", content: "Add authentication", status: "completed" },
        { id: "3", content: "Write unit tests", status: "pending" },
        { id: "4", content: "Ship the feature", status: "in_progress" },
      ],
    });
  });

  test("creates a single updateTodos part when cursor/update_todos arrives before the tool_call", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-todos-first:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTODOSFIRST: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-todos-first");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "updateTodos",
      toolTitle: "Update TODOs",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("stamps Grok todo_write rawInput onto a Todo Write part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-todo-write:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKTODOWRITE: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "grok-todo-write-1" &&
              Array.isArray((part.toolArgs as { todos?: unknown } | undefined)?.todos),
          ),
        ),
    );
    const part = settled.messages
      .flatMap((message) => message.parts)
      .find((item) => item.toolUseId === "grok-todo-write-1");
    expect(part).toMatchObject({
      toolName: "todo_write",
      toolTitle: "Todo Write",
      toolState: "success",
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("keeps each todo_write row on its own list when completions arrive late", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-todo-interleaved:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKTODOINTERLEAVED: continue" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) => part.toolUseId === "grok-todo-write-2" && part.toolState === "success",
          ),
        ),
    );
    const parts = settled.messages.flatMap((message) => message.parts);
    // The status-only update carries no arguments, so it must not merge the
    // first row's older snapshot back over the list the second row advanced.
    expect(parts.find((part) => part.toolUseId === "grok-todo-write-1")).toMatchObject({
      toolState: "success",
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
    expect(parts.find((part) => part.toolUseId === "grok-todo-write-2")).toMatchObject({
      toolState: "success",
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "3", content: "Write unit tests", status: "pending" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ],
      },
    });
  });

  test("merges a later Grok todo_write when merge is omitted", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-todo-merge:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKTODOWRITEMERGE: continue" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "grok-todo-write-2" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 4,
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "grok-todo-write-2"),
    ).toMatchObject({
      toolName: "todo_write",
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "3", content: "Write unit tests", status: "pending" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ],
      },
    });
  });

  test("renders an ACP plan update as a single todo_list part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-plan:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKPLAN: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "acp-plan" &&
              Array.isArray((part.toolArgs as { todos?: unknown } | undefined)?.todos),
          ),
        ),
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "todo_list",
      toolTitle: "Todo List",
      toolState: "success",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("renders a v2 plan_update as a single todo_list part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-plan-update:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKPLANUPDATE: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some((part) => part.toolUseId === "acp-plan"),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "acp-plan"),
    ).toMatchObject({
      toolName: "todo_list",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("folds a later ACP plan into the same Grok todo_write part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-todo-and-plan:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKTODOANDPLAN: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "grok-todo-write-1" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 2,
          ),
        ),
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolUseId: "grok-todo-write-1",
      toolName: "todo_write",
      toolTitle: "Todo Write",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Ship the feature", status: "in_progress" },
          { id: "2", content: "Write the docs", status: "pending" },
        ],
      },
    });
  });

  test("retargets a synthetic ACP plan part when todo_write arrives later", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-plan-then-todo:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKPLANTHENTODO: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some((part) => part.toolUseId === "grok-todo-write-1"),
        ),
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolUseId: "grok-todo-write-1",
      toolName: "todo_write",
      toolTitle: "Todo Write",
      toolArgs: {
        merge: false,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "in_progress" },
          { id: "3", content: "Write unit tests", status: "pending" },
        ],
      },
    });
  });

  test("merges a later Grok todo_write into a synthetic ACP plan when merge is omitted", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-plan-then-merge:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKPLANTHENMERGE: track work" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "grok-todo-write-1" &&
              (part.toolArgs as { todos?: unknown[] } | undefined)?.todos?.length === 4,
          ),
        ),
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "tool-invocation");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolUseId: "grok-todo-write-1",
      toolName: "todo_write",
      toolTitle: "Todo Write",
      toolArgs: {
        merge: true,
        todos: [
          { id: "1", content: "Set up project structure", status: "completed" },
          { id: "2", content: "Add authentication", status: "completed" },
          { id: "3", content: "Write unit tests", status: "pending" },
          { id: "4", content: "Ship the feature", status: "in_progress" },
        ],
      },
    });
  });

  test("replaces the ACP plan with an empty list", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-plan-empty:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "GROKPLANEMPTY: reset" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) =>
              part.toolUseId === "acp-plan" &&
              Array.isArray((part.toolArgs as { todos?: unknown[] } | undefined)?.todos) &&
              (part.toolArgs as { todos: unknown[] }).todos.length === 0,
          ),
        ),
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "acp-plan")?.toolArgs,
    ).toEqual({
      merge: false,
      todos: [],
    });
  });

  test("creates a single Task part when cursor/task arrives before the tool_call", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-first:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKFIRST: explore" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-first");
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      toolName: "task",
      toolTitle: "Task: Subagent task",
      agentState: "active",
      toolArgs: {
        description: "Explore the repo",
        prompt: "List the files that own native chat rendering.",
        subagent_type: "explore",
        model: "composer-2.5",
        agentId: "bc-first",
      },
    });
  });

  test("opens the next row for a synthetic cursor/task once the trailing row is full", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-cap:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKCAP: overflow" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    // Rows close at their soft bound, so nothing is trimmed to make room.
    expect(settled.messages.slice(1).map((message) => message.parts.length)).toEqual([256, 256, 1]);
    expect(settled.messages.at(-1)?.parts[0]).toMatchObject({
      toolUseId: "cursor-task-cap",
      toolName: "task",
      toolArgs: { description: "Overflow task", subagent_type: "explore" },
    });
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .filter((part) => part.toolUseId === "cursor-task-cap"),
    ).toHaveLength(1);
  });

  test("only accepts a real cursor/task duration, never a coerced null or blank", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-durations:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKDURATIONS: coerce" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const byId = new Map(
      settled.messages
        .flatMap((message) => message.parts)
        .map((part) => [part.toolUseId as string, part]),
    );

    // Reportable durations settle the sub-agent and survive into the args.
    expect(byId.get("duration-zero")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { durationMs: 0 },
    });
    expect(byId.get("duration-string")).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { durationMs: 1_500 },
    });
    expect(byId.get("duration-float")).toMatchObject({
      toolState: "success",
      toolArgs: { durationMs: 12 },
    });

    // Everything else means "no duration reported". `Number()` would turn
    // null/true/""/[] into 0 and finish a sub-agent that is still running, so
    // each must leave the part unsettled and carry no `durationMs` at all.
    for (const toolUseId of [
      "duration-negative",
      "duration-null",
      "duration-boolean",
      "duration-empty",
      "duration-array",
      "duration-text",
    ]) {
      const part = byId.get(toolUseId);
      expect({ toolUseId, part: part !== undefined }).toEqual({ toolUseId, part: true });
      expect({
        toolUseId,
        durationMs: (part?.toolArgs as { durationMs?: unknown })?.durationMs,
      }).toEqual({ toolUseId, durationMs: undefined });
      // Never reported complete, so the turn's own reconciliation settles it.
      expect({ toolUseId, agentState: part?.agentState }).toEqual({
        toolUseId,
        agentState: "failed",
      });
    }
  });

  test("keeps a null-duration cursor/task running and still reports it as activity", async () => {
    const directory = await temporaryDirectory();
    const holdTurnFile = resolve(directory, "release-turn");
    await shared.agentEnv({ FAKE_ACP_HOLD_TURN_FILE: holdTurnFile });
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-held:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKHELD: run" }),
        })
      ).status,
    ).toBe(202);

    // Observed while the turn is genuinely still open, not by racing its end.
    const running = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.status === "running" &&
        value.messages
          .flatMap((message) => message.parts)
          .some((part) => part.toolUseId === "cursor-task-held"),
    );
    const live = running.messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-held");
    expect(live).toMatchObject({
      toolName: "task",
      toolState: "pending",
      agentState: "active",
      toolArgs: { description: "Held task", subagent_type: "explore" },
    });
    expect((live!.toolArgs as { durationMs?: unknown }).durationMs).toBeUndefined();
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "working" });

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-task-held"),
    ).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { description: "Held task", durationMs: 2_400 },
    });
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("applies a cursor/task to its launch however many rows the turn has opened since", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-trimmed:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKTRIMMED: overflow" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    // The siblings fill the launch's row and open more, rather than trimming
    // the launch away. Its late metadata finds it there instead of rebuilding
    // a second card on the trailing row. (A launch a trim did remove is
    // covered in `acp-rows.test.ts`.)
    expect(settled.messages.length).toBeGreaterThan(2);
    const launches = settled.messages
      .flatMap((message) => message.parts)
      .filter((part) => part.toolUseId === "cursor-task-trimmed");
    expect(launches).toHaveLength(1);
    expect(settled.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "cursor-task-trimmed",
      agentState: "finished",
      toolArgs: { description: "Trimmed task" },
    });
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("preserves ACP nested child parentToolCallId as parentTaskUseId", async () => {
    const bridge = shared;
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-nested-subagent:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
          method: "POST",
          headers: bridge.headers,
          body: JSON.stringify({ prompt: "NESTEDSUBAGENT: inspect" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then(
          (response) => response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    const parts = settled.messages.flatMap((message) => message.parts);
    expect(parts.find((part) => part.toolUseId === "cursor-subagent-1")).toMatchObject({
      toolName: "task",
      agentState: "active",
    });
    // Every vendor spelling the bridge claims to accept, proven individually.
    expect(
      new Map(
        parts
          .filter(
            (part) =>
              typeof part.toolUseId === "string" && part.toolUseId.startsWith("cursor-child-"),
          )
          .map((part) => [part.toolUseId, part.parentTaskUseId]),
      ),
    ).toEqual(
      new Map([
        ["cursor-child-grep-1", "cursor-subagent-1"],
        ["cursor-child-read-2", "cursor-subagent-1"],
        ["cursor-child-edit-3", "cursor-subagent-1"],
        ["cursor-child-list-4", "cursor-subagent-1"],
        ["cursor-child-claude-5", "cursor-subagent-1"],
        ["cursor-child-claude-6", "cursor-subagent-1"],
        // A call naming itself is dropped rather than self-parented.
        ["cursor-child-self-7", undefined],
      ]),
    );
    expect(parts.find((part) => part.toolUseId === "cursor-child-grep-1")).toMatchObject({
      toolTitle: "Search Find",
      parentTaskUseId: "cursor-subagent-1",
    });
    expect(JSON.stringify(settled)).not.toContain("_meta");
    expect(JSON.stringify(settled)).not.toContain("parentToolCallId");
  });

  test("fails active child markers replayed while adopting provider history", async () => {
    await shared.agentEnv({ FAKE_ACP_REPLAY_ACTIVE_SUBAGENT: "1" });
    const bridge = shared;
    const listed = (await nativeFetch(`${bridge.base}/session/list`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      sessions: Array<{ id: string; title?: string }>;
    };
    const external = listed.sessions.find((session) => session.title === "Previous ACP work");
    expect(external).toBeDefined();

    const resumedResponse = await nativeFetch(`${bridge.base}/session/resume`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ sessionId: external!.id }),
    });
    expect(resumedResponse.status).toBe(201);
    const resumedMeta = (await resumedResponse.json()) as { sessionId: string };
    shared.track(resumedMeta.sessionId);
    const resumed = (await nativeFetch(`${bridge.base}/session/${resumedMeta.sessionId}`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(
      resumed.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "history-background-child"),
    ).toMatchObject({ toolState: "success", agentState: "failed" });
    expect(
      await nativeFetch(`${bridge.base}/session/${resumedMeta.sessionId}/activity`, {
        headers: bridge.headers,
      }).then((response) => response.json()),
    ).toEqual({ activity: "idle" });
  });

  test("fails a pending Task launch abandoned when its parent turn ends", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "PENDINGSUBAGENT" }),
    });
    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "abandoned-subagent-1"),
    ).toMatchObject({ toolState: "failure", agentState: "failed" });
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("latches a fatal error when active children exceed the bounded registry", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const { base, headers } = first;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "SUBAGENTOVERFLOW" }),
    });
    const failed = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "error",
    );
    expect(failed.error).toBe("acp-fixture exceeded the active sub-agent limit");
    expect(
      failed.messages
        .flatMap((message) => message.parts)
        .some((part) => part.agentState === "active"),
    ).toBe(false);
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle", turnFailed: true });

    const rejected = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toEqual({ error: "Session exceeded the active sub-agent limit" });
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle", turnFailed: true });

    await stopChild(first.child);
    const restarted = await spawnBridge({ stateDirectory });
    const rejectedAfterRestart = await nativeFetch(
      `${restarted.base}/session/${created.id}/prompt`,
      {
        method: "POST",
        headers: restarted.headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      },
    );
    expect(rejectedAfterRestart.status).toBe(409);
    expect(await rejectedAfterRestart.json()).toEqual({
      error: "Session exceeded the active sub-agent limit",
    });
  });

  test("correlates concurrent Grok children without claiming mismatched spawns", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    const read = async () =>
      nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{
        status: string;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "GROKMULTISUBAGENT" }),
    });
    await waitFor(
      read,
      (value) =>
        value.status === "idle" &&
        value.messages
          .flatMap((message) => message.parts)
          .filter((part) => part.agentState === "active").length === 2,
    );

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FAILGROKSUBAGENT_B" }),
    });
    const oneActive = await waitFor(
      read,
      (value) =>
        value.status === "idle" &&
        value.messages
          .flatMap((message) => message.parts)
          .some((part) => part.toolUseId === "grok-multi-tool-b" && part.agentState === "failed"),
    );
    const parts = oneActive.messages.flatMap((message) => message.parts);
    expect(parts.find((part) => part.toolUseId === "grok-multi-tool-a")).toMatchObject({
      agentState: "active",
    });
    expect(parts.find((part) => part.toolUseId === "grok-multi-tool-b")).toMatchObject({
      agentState: "failed",
    });
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CANCELGROKSUBAGENT_A" }),
    });
    await waitFor(
      read,
      (value) =>
        value.status === "idle" &&
        value.messages
          .flatMap((message) => message.parts)
          .some((part) => part.toolUseId === "grok-multi-tool-a" && part.agentState === "failed"),
    );
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("keeps Grok child activity authoritative across transcript eviction and a late finish", async () => {
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        ACP_MAX_TRANSCRIPT_BYTES: "1048576",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    const read = async () =>
      nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "EVICTGROKSUBAGENT" }),
    });
    const evicted = await waitFor(read, (value) => value.status === "idle");
    expect(
      evicted.messages
        .flatMap((message) => message.parts)
        .some((part) => part.toolUseId === "grok-evicted-tool"),
    ).toBe(false);
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDGROKSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
    const after = await read();
    expect(after.baseIndex).toBeGreaterThan(0);
    expect(
      after.messages
        .flatMap((message) => message.parts)
        .some((part) => part.toolUseId === "grok-evicted-tool"),
    ).toBe(false);
  });

  test("normalizes failing tool calls into failed parts with an error message", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-fail" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FAILTOOL: break things" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const parts = session.messages[1]?.parts;
    expect(parts?.map((part) => part.type)).toEqual(["tool-invocation", "tool-invocation"]);
    expect(session.messages[2]?.parts.map((part) => part.type)).toEqual(["text"]);
    const failWithPayload = parts?.find((part) => part.toolUseId === "fail-1");
    expect(failWithPayload).toMatchObject({
      toolState: "failure",
      toolOutput: JSON.stringify({ error: "boom" }, null, 2),
      toolError: JSON.stringify({ error: "boom" }, null, 2),
    });
    const failWithoutPayload = parts?.find((part) => part.toolUseId === "fail-2");
    expect(failWithoutPayload).toMatchObject({
      toolState: "failure",
      toolError: "Tool call failed",
    });
    expect(failWithoutPayload?.toolOutput).toBeUndefined();
  });

  test("preserves content output when a later patch updates only raw output", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-stream" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "STREAMTOOL: find references" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const stream = session.messages[1]?.parts.find((part) => part.toolUseId === "stream-1");
    expect(stream).toMatchObject({
      toolState: "success",
      toolOutput: "Searching for references...",
    });
    expect(stream?.toolDiff).toBeUndefined();
  });

  test("applies nullable and replacement tool update fields without stale metadata", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-patch" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "PATCHTOOLS: clear stale fields" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // Every nullable field is gone: no stale title, name, args, output or diff
    // survives. The state is the one exception — clearing it to `null` left the
    // tool with no terminal status, so ending the turn settled it as unfinished
    // rather than leaving it indeterminate forever.
    const cleared = session.messages[1]?.parts.find((part) => part.toolUseId === "clear-1");
    expect(cleared).toEqual({
      type: "tool-invocation",
      content: "Tool call",
      sourcePartId: "tool:clear-1",
      sourceMessageId: expect.any(String),
      toolUseId: "clear-1",
      toolState: "failure",
      toolError: "Tool call ended without a result",
      createdAt: expect.any(String),
    });
  });

  test("combines every ACP file diff and counts only actual changed lines", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-multi" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MULTIDIFF: edit two files" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "multi-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ additions: 2, deletions: 2 });
    expect(diff?.filePath).toBeUndefined();
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(diff?.diff).toEqual(expect.any(String));
    const rendered = diff?.diff as string;
    expect(rendered).toContain("--- src/first.ts");
    expect(rendered).toContain("+++ src/second.ts");
    expect(rendered).toContain(" const shared = true;");
    expect(rendered).toContain("-const value = 1;");
    expect(rendered).toContain("+const value = 2;");
    expect(rendered).toContain("-before");
    expect(rendered).toContain("+after");
  });

  test("renders a small edit to a large file as hunks, not the whole file", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-context" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CONTEXTEDIT: touch one line" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "context-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/large.ts", additions: 1, deletions: 1 });
    const rendered = diff?.diff as string;
    // The change, three lines of context either side, and the headers — not the
    // 5,000-line file. Rendering every line is what exhausted the transcript.
    expect(rendered.split("\n")).toHaveLength(11);
    expect(rendered).toContain("@@ -2498,7 +2498,7 @@");
    expect(rendered).toContain("-const line_2500 = 2500;");
    expect(rendered).toContain("+const line_2500 = 2500; // touched");
    expect(rendered).toContain(" const line_2497 = 2497;");
    expect(rendered).toContain(" const line_2503 = 2503;");
    expect(rendered).not.toContain("line_2496");
    expect(rendered).not.toContain("line_2504");
    // The whole-file states are not carried alongside the rendering either, so
    // one edit costs its hunk rather than three copies of the file.
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(1024);
  });

  test("renders separated changes and file boundaries as correctly positioned hunks", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-multi-hunk" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MULTIHUNK: touch the boundaries and middle" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "multi-hunk-1");
    const diff = (tool?.toolDiff as { diff?: string } | undefined)?.diff ?? "";
    expect(diff.match(/^@@/gm)).toEqual(["@@", "@@", "@@"]);
    expect(diff).toContain("@@ -1,4 +1,4 @@");
    expect(diff).toContain("@@ -7,7 +7,7 @@");
    expect(diff).toContain("@@ -17,4 +17,4 @@");
    expect(diff).toContain("-line 1\n+line 1 changed");
    expect(diff).toContain("-line 10\n+line 10 changed");
    expect(diff).toContain("-line 20\n+line 20 changed");
    expect(diff).not.toContain(" line 5");
    expect(diff).not.toContain(" line 15");
  });

  test("renders an edit with no changed lines as an empty hunk", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-noop-edit" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "NOOPEDIT: rewrite a file unchanged" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "noop-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    // Nothing changed, so there is no hunk to place: the headers and a bare
    // `@@` say exactly that, where rendering every line said the opposite.
    expect(diff?.diff).toBe("--- src/noop.ts\n+++ src/noop.ts\n@@");
    expect(diff).toMatchObject({ filePath: "src/noop.ts", additions: 0, deletions: 0 });
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
  });

  test("normalizes terminal and text tool content in protocol order", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-terminal" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TERMINALTOOL: run checks" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "terminal-1",
      toolState: "success",
      toolOutput: "[Terminal terminal-42]\nChecks passed",
    });
  });

  test("starts a tool call on a fresh assistant message when it leads the turn", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-lead" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TOOLSFIRST: start with a tool" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ id: string; role: string; parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The call opens the first assistant row; the prose after it is the next
    // response, on a row of its own.
    expect(session.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
    expect(session.messages[1]?.parts.map((part) => part.type)).toEqual(["tool-invocation"]);
    expect(session.messages[2]?.parts.map((part) => part.type)).toEqual(["text"]);
    expect(session.messages[1]?.parts[0]).toMatchObject({
      toolUseId: "lead-1",
      toolName: "plan",
      toolArgs: { goal: "ship it" },
      // The agent ended the turn without ever completing this tool, so it is
      // settled rather than left spinning.
      toolState: "failure",
    });
  });

  test("bounds tool arguments, outputs, and diffs to their display limits", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-big" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BIGTOOL: edit a huge file" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const big = session.messages[1]?.parts.find((part) => part.toolUseId === "big-1");
    expect(big).toBeDefined();
    expect(big?.toolArgs).toEqual({
      _orkestrator: "Tool input omitted because it exceeded the 512 KiB display limit",
    });
    expect(big?.toolOutput).toEqual(expect.any(String));
    expect(Buffer.byteLength(big?.toolOutput as string)).toBe(512 * 1024);
    expect((big!.toolOutput as string).endsWith("\n… tool output truncated")).toBe(true);
    const toolDiff = big?.toolDiff as Record<string, unknown> | undefined;
    expect(toolDiff).toMatchObject({ filePath: "huge.ts", additions: 1, deletions: 1 });
    // Bounded, and the cut is announced rather than silently dropping the tail.
    expect(Buffer.byteLength(toolDiff?.diff as string)).toBeLessThanOrEqual(1024 * 1024);
    expect((toolDiff!.diff as string).endsWith("\n… file diff truncated")).toBe(true);
    expect(toolDiff?.diff).toEqual(expect.stringContaining("-old\n+new"));
    expect(toolDiff?.before).toBeUndefined();
    expect(toolDiff?.after).toBeUndefined();
  });

  test("trims the oldest parts, and announces it, when one response exhausts the per-message limit", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-many" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MANYPARTS: one oversized response" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => (value.messages[1]?.parts.length ?? 0) >= 512,
    );

    // An interactive turn survives its own volume: failing here would strand
    // the whole conversation behind the tab's connection-failure screen.
    expect(session.status).toBe("running");
    expect(session.error).toBeUndefined();
    expect(session.messages[1]?.parts).toHaveLength(512);
    // The oldest parts went, and the cut says so rather than reading as a
    // response that never said those things.
    expect(session.messages[1]?.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(session.messages[1]?.parts.at(-1)).toMatchObject({
      type: "thinking",
      content: "part-512 ",
    });
  });

  test("opens the next row for back-to-back calls instead of trimming one", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-many-calls" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MANYTOOLS: flood the turn" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) =>
        value.messages.some((message) =>
          message.parts.some((part) => part.toolUseId === "many-512"),
        ),
    );

    // No message id and no prose between the calls gives them no response
    // boundary, so the row closes at its soft bound and none is ever trimmed.
    expect(session.status).toBe("running");
    expect(session.messages.slice(1).map((message) => message.parts.length)).toEqual([256, 256, 1]);
    expect(
      session.messages
        .slice(1)
        .every((message) => message.parts.every((part) => part.type === "tool-invocation")),
    ).toBe(true);
  });

  test("completes an early call on its own row however many rows have opened since", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-trimmed-tool" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TRIMMEDTOOLUPDATE: complete an evicted call" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const parts = session.messages.flatMap((message) => message.parts);
    expect(session.error).toBeUndefined();
    // The fillers open new rows rather than trimming `early-1` away, so its
    // completion lands on the card it belongs to, not on a second, empty
    // `Tool call` at the end of the turn. (A late update for a call a trim did
    // remove is covered in `acp-rows.test.ts`.)
    expect(session.messages.slice(1).map((message) => message.parts.length)).toEqual([256, 256, 9]);
    expect(parts.filter((part) => part.toolUseId === "early-1")).toEqual([
      expect.objectContaining({
        toolState: "success",
        toolTitle: "Start the long build",
        toolOutput: "build finished",
      }),
    ]);
    expect(session.messages[1]?.parts[0]).toMatchObject({ toolUseId: "early-1" });
    expect(parts.at(-1)).toMatchObject({ toolUseId: "filler-519" });
  });

  test("bounds an aggregate interactive transcript and preserves its trim across restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-transcript-overflow" }),
    }).then((response) => response.json())) as { id: string };

    await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "TRANSCRIPTOVERFLOW: fill the display budget" }),
    });
    const read = async (base: string, headers: Record<string, string>) =>
      (await nativeFetch(`${base}/session/${created.id}/messages`, { headers }).then((response) =>
        response.json(),
      )) as {
        status: string;
        error?: string;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
        revision: number;
        messageWindow: { truncated: boolean; omittedMessages?: number; omittedParts?: number };
      };
    const bounded = await waitFor(
      () => read(first.base, first.headers),
      (value) => value.status === "idle",
      BRIDGE_STARTUP_TIMEOUT_MS,
    );

    const assistant = bounded.messages.at(-1)!;
    expect(bounded.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(bounded.messages))).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    expect(assistant.parts.length).toBeLessThan(34);
    expect(assistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(bounded.messageWindow.truncated).toBe(true);
    expect(bounded.messageWindow.omittedParts).toBeGreaterThan(0);
    expect(assistant.parts.at(-1)).toMatchObject({ toolUseId: "large-33", toolState: "success" });
    const retainedToolIds = assistant.parts.flatMap((part) =>
      typeof part.toolUseId === "string" ? [part.toolUseId] : [],
    );

    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory });
    const restored = await read(second.base, second.headers);
    const restoredAssistant = restored.messages.at(-1)!;
    expect(restored.status).toBe("idle");
    expect(restored.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(restored.messages))).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    expect(restoredAssistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(
      restoredAssistant.parts.flatMap((part) =>
        typeof part.toolUseId === "string" ? [part.toolUseId] : [],
      ),
    ).toEqual(retainedToolIds);
    expect(restored.messageWindow).toEqual(bounded.messageWindow);

    // A read re-bounds the transcript, but only when something was appended
    // since the last check: a steady-state poll of a large idle session must
    // not re-serialize it, and must not mutate what it returns.
    const readAgain = await read(second.base, second.headers);
    expect(readAgain.messages).toEqual(restored.messages);
    expect(readAgain.revision).toBe(restored.revision);

    const compressed = await nativeFetch(`${second.base}/session/${created.id}/messages`, {
      headers: { ...second.headers, "accept-encoding": "gzip" },
    });
    expect(compressed.headers.get("content-encoding")).toBe("gzip");
    expect(compressed.headers.get("vary")).toContain("Accept-Encoding");
    expect(Number(compressed.headers.get("content-length"))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(restored.messages)),
    );
    expect(((await compressed.json()) as { messages: unknown[] }).messages.length).toBe(
      restored.messages.length,
    );

    const refused = await nativeFetch(`${second.base}/session/${created.id}/messages`, {
      headers: { ...second.headers, "accept-encoding": "gzip;q=0, *;q=1" },
    });
    expect(refused.headers.get("content-encoding")).toBeNull();
    expect(((await refused.json()) as { messages: unknown[] }).messages.length).toBe(
      restored.messages.length,
    );
  });

  /**
   * `failTranscriptLimit` is the one error path that deliberately keeps its
   * children registered — transcript retention is presentation-only, and a
   * display bound is not evidence that a background child stopped writing
   * files. `/activity` therefore must not read `error` as idle: the child is
   * still running, and reporting the environment idle would fire a completion
   * edge and let a build pipeline advance underneath it.
   */
  test("keeps reporting working when a transcript-limit failure retains a live child", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);
    const read = async () =>
      nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{
        status: string;
        error?: string;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;
    const activity = async () =>
      nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{ activity: string }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    await waitFor(
      read,
      (value) =>
        value.status === "idle" &&
        value.messages.some((message) =>
          message.parts.some(
            (part) => part.toolUseId === "cursor-subagent-1" && part.agentState === "active",
          ),
        ),
    );
    expect(await activity()).toEqual({ activity: "working" });

    // A structured turn is worth exactly its complete output, so exhausting the
    // per-message bound fails it rather than trimming. Nothing in that path
    // touches the sub-agent registry.
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "MANYPARTS: one oversized response",
        outputSchema: { type: "object" },
      }),
    });
    const failed = await waitFor(read, (value) => value.status === "error");
    expect(failed.error).toContain("exceeded the transcript limit");
    expect(
      failed.messages
        .flatMap((message) => message.parts)
        .find((part) => part.toolUseId === "cursor-subagent-1"),
    ).toMatchObject({ agentState: "active" });
    expect(await activity()).toEqual({ activity: "working" });
  });

  test("heals a session an older build failed for exceeding the transcript limit", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "acp-fixture",
        sessions: [
          {
            id: "session-trim-failed",
            clientSessionKey: "env-1:tab-trimmed",
            acpSessionId: "acp-session-trimmed",
            status: "error",
            error: "acp-fixture output exceeded the transcript limit",
            revision: 9,
            structured: [],
            promptJournal: [],
            messages: [
              {
                id: "message-1",
                role: "assistant",
                content: "Done.",
                parts: [
                  {
                    type: "text",
                    content: "Done.",
                    sourcePartId: "message-1:0",
                    sourceMessageId: "message-1",
                  },
                ],
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
          {
            id: "session-really-failed",
            clientSessionKey: "env-1:tab-broken",
            acpSessionId: "acp-session-broken",
            status: "error",
            error: "acp-fixture exited before the turn completed",
            revision: 2,
            structured: [],
            promptJournal: [],
            messages: [],
          },
        ],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const read = async (id: string) =>
      (await nativeFetch(`${bridge.base}/session/${id}`, { headers: bridge.headers }).then(
        (response) => response.json(),
      )) as { status: string; error?: string };

    // The persisted failure is a display-budget artifact of an older build, and
    // nothing in the tab can clear it: the only control there reads it back.
    const healed = await read("session-trim-failed");
    expect(healed.status).toBe("idle");
    expect(healed.error).toBeUndefined();

    // Every other failure is the agent's, and still has to survive the restart.
    const broken = await read("session-really-failed");
    expect(broken.status).toBe("error");
    expect(broken.error).toBe("acp-fixture exited before the turn completed");
  });

  test("settles a tool left in flight when a live turn ends, without a restart", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-hang" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "HANGTOOL: abandon a tool" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The in-flight tool settles even though this bridge process never reloaded
    // persisted state — the turn ending is what resolves it.
    const abandoned = session.messages[1]?.parts.find((part) => part.toolUseId === "hang-1");
    expect(abandoned).toMatchObject({
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
    // A tool that already reported a terminal state is left exactly as it was.
    const finished = session.messages[1]?.parts.find((part) => part.toolUseId === "hang-done");
    expect(finished).toMatchObject({ toolState: "success" });
    expect(finished?.toolError).toBeUndefined();
  });

  test("keeps a known tool state when an update carries an unrecognized status", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-odd" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "ODDSTATUS: send a future status" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    // The unknown status left `pending` intact rather than erasing the state, so
    // the end-of-turn settle could still recognise the tool as unfinished.
    expect(session.messages[1]?.parts.find((part) => part.toolUseId === "odd-1")).toMatchObject({
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });

  test("omits aggregate counts when any file diff has no countable stats", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-mixed" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "MIXEDSTATS: one countable, one not" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "mixed-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    // A partial sum would understate the change, so no counts are reported at
    // all — but both files' renderings still appear.
    expect(diff?.additions).toBeUndefined();
    expect(diff?.deletions).toBeUndefined();
    expect(diff?.diff).toContain("-before");
    expect(diff?.diff).toContain("+after");
    expect(diff?.diff).toContain("@@ diff omitted: file state exceeded display limit @@");
  });

  test("discards a chunk small enough to fit in what truncation left over", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    shared.track(created.id);
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "SATURATEDSTREAM: one chunk past the cap" }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ content: string; parts: Array<{ type: string; content: string }> }>;
        }>,
      (value) => value.status === "idle",
    );

    const assistant = session.messages[1]!;
    const textPart = assistant.parts.find((part) => part.type === "text")!;
    const marker = "[output truncated by Orkestrator]";
    expect(session.error).toBeUndefined();
    expect(Buffer.byteLength(assistant.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(textPart.content)).toBeLessThanOrEqual(2 * 1024 * 1024);
    // The cut is announced exactly once and the announcement stays terminal.
    // Truncation leaves the buffer a byte under the cap, and a chunk small
    // enough to fit in it must still be discarded: appending it would render
    // as `…[output truncated by Orkestrator]!`, which reads as corruption
    // rather than as a response that was cut short.
    expect(assistant.content.split(marker)).toHaveLength(2);
    expect(textPart.content.split(marker)).toHaveLength(2);
    expect(assistant.content.endsWith(marker)).toBe(true);
    expect(textPart.content.endsWith(marker)).toBe(true);
    expect(assistant.content).not.toContain("!");
    expect(textPart.content).not.toContain("!");
    // The backed-off code point must not have decoded into a replacement char.
    expect(assistant.content).not.toContain("�");
  });

  test("serves an incremental transcript window anchored to an absolute index", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    shared.track(created.id);
    for (const [index, text] of ["first", "second"].entries()) {
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: `DIRECT:${text}`, requestId: `window-${index}` }),
      });
      await waitFor(
        async () =>
          nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
            response.json(),
          ) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );
    }

    const full = (await nativeFetch(`${base}/session/${created.id}/messages`, { headers }).then(
      (response) => response.json(),
    )) as { messages: Array<{ content: string }>; baseIndex: number; totalMessages: number };
    expect(full.messages.map((message) => message.content)).toEqual([
      "DIRECT:first",
      "first",
      "DIRECT:second",
      "second",
    ]);
    expect(full.baseIndex).toBe(0);
    expect(full.totalMessages).toBe(4);

    const tail = (await nativeFetch(`${base}/session/${created.id}/messages?fromIndex=3`, {
      headers,
    }).then((response) => response.json())) as {
      messages: Array<{ content: string }>;
      baseIndex: number;
    };
    expect(tail.messages.map((message) => message.content)).toEqual(["second"]);
    expect(tail.baseIndex).toBe(3);

    // Past the end and unparseable cursors clamp instead of throwing.
    const beyond = (await nativeFetch(`${base}/session/${created.id}/messages?fromIndex=99`, {
      headers,
    }).then((response) => response.json())) as { messages: unknown[]; baseIndex: number };
    expect(beyond.messages).toEqual([]);
    expect(beyond.baseIndex).toBe(4);
    const garbage = (await nativeFetch(
      `${base}/session/${created.id}/messages?fromIndex=not-a-number`,
      { headers },
    ).then((response) => response.json())) as { messages: unknown[]; baseIndex: number };
    expect(garbage.baseIndex).toBe(0);
    expect(garbage.messages).toHaveLength(4);
  });
});

// The lowered budget is a bridge-level setting, so these share a second bridge.
describe("ACP bridge with a lowered transcript budget", () => {
  const shared = sharedBridge({
    ACP_MAX_TRANSCRIPT_BYTES: String(1024 * 1024),
    ACP_CLOSE_CANCEL_WAIT_MS: "200",
  });

  test("charges a cursor/task prompt so a near-cap transcript stays inside the byte budget", async () => {
    const maximumTranscriptBytes = 1024 * 1024;
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-task-charge:tab-1" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    expect(
      (
        await nativeFetch(`${base}/session/${created.id}/prompt`, {
          method: "POST",
          headers,
          body: JSON.stringify({ prompt: "CURSORTASKCHARGE: fill then prompt" }),
        })
      ).status,
    ).toBe(202);

    const settled = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    expect(settled.error).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(settled.messages))).toBeLessThanOrEqual(
      maximumTranscriptBytes,
    );
    const charged = settled.messages
      .flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "cursor-task-charge");
    expect(charged).toMatchObject({
      toolName: "task",
      toolArgs: { description: "Charge the prompt", subagent_type: "explore" },
    });
    expect((charged?.toolArgs as { prompt?: string } | undefined)?.prompt?.length).toBe(64 * 1024);
  });

  test("settles an evicted Cursor child without rebuilding a ghost launch part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);
    const read = async () =>
      nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDCURSORSUBAGENT" }),
    });
    const settled = await waitFor(read, (value) => value.status === "idle");
    expect(settled.baseIndex).toBeGreaterThan(0);
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .some((part) => part.toolUseId === "cursor-subagent-1"),
    ).toBe(false);
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("settles an evicted Cursor child from cursor/task without rebuilding a ghost launch part", async () => {
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);
    const read = async () =>
      nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
        response.json(),
      ) as Promise<{
        status: string;
        baseIndex: number;
        messages: Array<{ parts: Array<Record<string, unknown>> }>;
      }>;

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
    });
    await waitFor(read, (value) => value.status === "idle");
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "working" });

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHEVICTEDCURSORTASK" }),
    });
    const settled = await waitFor(read, (value) => value.status === "idle");
    expect(settled.baseIndex).toBeGreaterThan(0);
    expect(
      settled.messages
        .flatMap((message) => message.parts)
        .some((part) => part.toolUseId === "cursor-subagent-1"),
    ).toBe(false);
    expect(
      await nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
        response.json(),
      ),
    ).toEqual({ activity: "idle" });
  });

  test("starts a new part when a chunk follows a message trimmed to its notice", async () => {
    // The floor is reached when two parts alone still exceed the budget, and
    // at 16 MiB the per-part caps do not add up to that. Lowering the budget
    // (this describe's bridge) is the only way to exercise it; it can only ever
    // move downwards.
    const { base, headers } = shared;
    const created = (await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-trim-to-text" }),
    }).then((response) => response.json())) as { id: string };
    shared.track(created.id);

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "TRIMTOTEXT: empty the message, then speak" }),
    });
    // Wait on `/activity`, which never bounds the transcript. A session read
    // does (`boundTranscriptForRead`), and one landing between the two tool
    // parts resets the write path's byte counter, so the trim waits for the
    // next read; the chunk then follows an untrimmed tool call and opens a row
    // of its own, leaving the trimmed message behind it (2410). The scenario
    // needs the trim the agent's own updates trigger, before the chunk.
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}/activity`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ activity: string }>,
      (value) => value.activity === "idle",
    );
    const session = (await nativeFetch(`${base}/session/${created.id}`, { headers }).then(
      (response) => response.json(),
    )) as {
      status: string;
      error?: string;
      messages: Array<{ role: string; content: string; parts: Array<Record<string, unknown>> }>;
    };
    expect(session.status).toBe("idle");

    // The lowered budget evicts whole messages before it trims parts, so the
    // prompt itself is gone and the assistant message is all that is left.
    const assistant = session.messages.at(-1)!;
    expect(session.error).toBeUndefined();
    expect(assistant.role).toBe("assistant");
    // Both tool parts went, so the notice is the message's *only* part and
    // therefore also its last. The chunk that follows must start its own part:
    // streaming into the notice would rewrite the announcement as agent output
    // and lose it.
    expect(assistant.parts).toHaveLength(2);
    expect(assistant.parts[0]).toMatchObject({
      type: "text",
      content: expect.stringContaining("Earlier steps in this response were dropped"),
    });
    expect(assistant.parts[1]).toMatchObject({ type: "text", content: "Recovered summary." });
    expect(assistant.content).toBe("Recovered summary.");

    const window = (await nativeFetch(`${base}/session/${created.id}/messages`, { headers }).then(
      (response) => response.json(),
    )) as {
      messageWindow: { truncated: boolean; omittedMessages?: number; omittedParts?: number };
    };
    expect(window.messageWindow.truncated).toBe(true);
    expect(window.messageWindow.omittedMessages).toBeGreaterThan(0);
    expect(window.messageWindow.omittedParts).toBeGreaterThan(0);
  });
});
