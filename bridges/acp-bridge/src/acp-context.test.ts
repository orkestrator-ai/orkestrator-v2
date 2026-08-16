import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ONE_PIXEL_PNG,
  here,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";


describe("ACP bridge", () => {



  // The fake agent records its own argv, so these assert the exact command line
  // the bridge builds. They cannot prove the real CLIs accept those flags —
  // `docs/upgrade-agents.md` carries that as a manual step for version bumps.
  async function readAgentArgs(env: NodeJS.ProcessEnv): Promise<string[]> {
    const argsFile = resolve(await temporaryDirectory(), "args.log");
    const { base, headers } = await spawnBridge({
      env: { ...env, FAKE_ACP_ARGS_FILE: argsFile },
    });

    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    });
    expect(created.status).toBe(201);

    const recorded = await waitFor(
      async () => fs.readFile(argsFile, "utf8").catch(() => ""),
      (value) => value.trim().length > 0,
    );
    // One session spawns one agent. A second line would mean the child was
    // restarted, which should fail as itself rather than as a JSON parse error
    // on two concatenated records.
    const lines = recorded.trim().split("\n");
    expect(lines).toHaveLength(1);
    return JSON.parse(lines[0]!) as string[];
  }



  for (const acpProvider of ["cursor", "grok"] as const) {
    test(`lists and resumes provider-owned ${acpProvider} sessions`, async () => {
      const directory = await temporaryDirectory();
      const lifecycleFile = resolve(directory, `${acpProvider}-resume-lifecycle.log`);
      const bridge = await spawnBridge({ env: {
        ACP_PROVIDER: acpProvider,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_REPLAY_HISTORY: "1",
      } });
      const created = await nativeFetch(`${bridge.base}/session/create`, {
        method: "POST",
        headers: bridge.headers,
      }).then((response) => response.json()) as { id: string };

      const firstListResponse = await nativeFetch(`${bridge.base}/session/list`, {
        headers: bridge.headers,
      });
      expect(firstListResponse.status).toBe(200);
      const firstList = await firstListResponse.json() as {
        sessions: Array<{
          id: string;
          title?: string;
          updatedAt?: string;
          messageCount?: number;
        }>;
      };
      expect(firstList.sessions).toHaveLength(2);
      // Sessions already represented by bridge state retain that stable ID, so
      // the shared picker can exclude the session the current tab already owns.
      expect(firstList.sessions.find((session) => session.title === "Current ACP work"))
        .toMatchObject({ id: created.id, messageCount: 4 });
      const external = firstList.sessions.find((session) => session.title === "Previous ACP work");
      expect(external).toMatchObject({
        updatedAt: "2026-08-13T20:00:00.000Z",
        messageCount: 12,
      });
      expect(external?.id).not.toBe("external-session");

      const tampered = `${external!.id.slice(0, -1)}${external!.id.endsWith("A") ? "B" : "A"}`;
      const rejected = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ sessionId: tampered }),
      });
      expect(rejected.status).toBe(404);

      const resumedResponse = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({
          sessionId: external!.id,
        }),
      });
      expect(resumedResponse.status).toBe(201);
      const resumed = await resumedResponse.json() as {
        id: string;
        sessionId: string;
        status: string;
        messages: Array<{ role: string; content: string }>;
      };
      expect(resumed.id).toBe(resumed.sessionId);
      expect(resumed.id).not.toBe(external!.id);
      expect(resumed.status).toBe("idle");
      expect(resumed.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "Earlier question"],
        ["assistant", "Earlier answer continued"],
      ]);
      expect(await fs.readFile(lifecycleFile, "utf8")).toContain("load:");

      // Once adopted, the same provider conversation resolves to the stable
      // bridge id instead of producing another wrapper around one ACP session.
      const secondList = await nativeFetch(`${bridge.base}/session/list`, {
        headers: bridge.headers,
      }).then((response) => response.json()) as { sessions: Array<{ id: string; title?: string }> };
      expect(secondList.sessions.find((session) => session.title === "Previous ACP work")?.id)
        .toBe(resumed.id);
      const duplicate = await nativeFetch(`${bridge.base}/session/resume`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ sessionId: resumed.id }),
      }).then((response) => response.json()) as { id: string };
      expect(duplicate.id).toBe(resumed.id);
    });
  }



  for (const env of ["FAKE_ACP_LIST_MISSING_CWD", "FAKE_ACP_LIST_WRONG_CWD"] as const) {
    test(`does not list ACP sessions with ${env}`, async () => {
      const bridge = await spawnBridge({ env: { [env]: "1" } });
      const response = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sessions: [] });
    });
  }



  test("stops paging when the agent repeats a cursor it already issued", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "looping-cursors.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIST_REPEAT_CURSOR: "1",
      FAKE_ACP_LIST_COUNTER_FILE: counterFile,
    } });

    const listed = await nativeFetch(`${bridge.base}/session/list`, { headers: bridge.headers })
      .then((response) => response.json()) as { sessions: Array<{ title?: string }> };

    expect(listed.sessions.map((session) => session.title)).toEqual(["Looping ACP work"]);
    // Two requests: the first issues the cursor, the second sees it repeat and
    // breaks rather than running to the page cap.
    expect(await fs.readFile(counterFile, "utf8")).toBe("<none>\nsame-cursor\n");
  });



  for (const { provider, modelId } of [
    { provider: "cursor", modelId: "gpt-5.5" },
    { provider: "grok", modelId: "grok-composer-2.5-fast" },
  ] as const) {
    test(`attributes ${provider} assistant messages to the selected model across restart`, async () => {
      const stateDirectory = await temporaryDirectory();
      const first = await spawnBridge({
        stateDirectory,
        env: { ACP_PROVIDER: provider },
      });
      const created = await nativeFetch(`${first.base}/session/create`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({ clientSessionKey: `env-model:${provider}` }),
      }).then((response) => response.json()) as { id: string };

      const dispatched = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({
          prompt: "DIRECT:model attribution",
          requestId: `model-attribution-${provider}`,
          modelId,
        }),
      });
      expect(dispatched.status).toBe(202);

      const session = await waitFor(
        () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ role: string; modelId?: string }>;
          }>,
        (value) => value.status === "idle",
      );
      expect(session.messages.find((message) => message.role === "assistant")?.modelId)
        .toBe(modelId);

      await waitFor(
        () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8")
          .then((contents) => JSON.parse(contents) as {
            sessions: Array<{ messages: Array<{ role: string; modelId?: string }> }>;
          }),
        (value) => value.sessions.some((persisted) =>
          persisted.messages.some((message) =>
            message.role === "assistant" && message.modelId === modelId
          )
        ),
      );
      await stopChild(first.child);

      const restarted = await spawnBridge({
        stateDirectory,
        env: { ACP_PROVIDER: provider },
      });
      const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
        headers: restarted.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; modelId?: string }>;
      };
      expect(restored.messages.find((message) => message.role === "assistant")?.modelId)
        .toBe(modelId);
    });
  }



  test("carries launch arguments across a rawInput patch that drops them", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-preserve-non-task:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORPRESERVENONTASK: read" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    // The carry-over exists for Cursor's Task launches, whose status patches
    // arrive as a bare `{ _toolName: "task" }`, but it is keyed on the argument
    // names rather than the tool, so any tool reusing them keeps the earlier
    // value when a later patch omits it. The patched key still wins.
    expect(settled.messages.flatMap((message) => message.parts)
      .find((part) => part.toolUseId === "plain-tool-1")).toMatchObject({
      toolState: "success",
      toolArgs: {
        path: "/workspace/b.ts",
        description: "First pass",
        model: "m-1",
      },
    });
  });



  for (const terminal of [
    { prompt: "FINISHCURSORSUBAGENT", agentState: "finished", toolState: "success" },
    { prompt: "FINISHCURSORSUBAGENTSTATUS", agentState: "finished", toolState: "success" },
    { prompt: "FINISHCURSORTASK", agentState: "finished", toolState: "success" },
    { prompt: "FAILCURSORTASK", agentState: "failed", toolState: "success" },
    { prompt: "REJECTCURSORTASK", agentState: "failed", toolState: "success" },
    { prompt: "FAILCURSORSUBAGENT", agentState: "failed", toolState: "failure" },
  ] as const) {
    test(`settles Cursor's in-process child via ${terminal.prompt} as ${terminal.agentState}`, async () => {
      const { base, headers } = await spawnBridge();
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
          )),
      );

      const terminalResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: terminal.prompt }),
      });
      expect(terminalResponse.status).toBe(202);
      const settled = await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === terminal.agentState
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: terminal.toolState, agentState: terminal.agentState });
      expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json())).toEqual({ activity: "idle" });
    });
  }



  // The request form is the only one the pinned `cursor-agent` sends: its
  // `sendNonBlockingExtensionNotification` helper calls `extMethod`, which is
  // `sendRequest`. The answer is a bare `{}` because Cursor discards the result
  // and the method publishes no response schema to fill in.
  for (const request of [
    { prompt: "FINISHCURSORTASKREQUEST", label: "a completed child", agentState: "finished" },
    { prompt: "FAILCURSORTASKREQUEST", label: "a failed child", agentState: "failed" },
  ] as const) {
    test(`answers Cursor's cursor/task request for ${request.label} and settles it`, async () => {
      const directory = await temporaryDirectory();
      const responseFile = resolve(directory, "cursor-task-response.log");
      const { base, headers } = await spawnBridge({ env: {
        FAKE_ACP_CURSOR_TASK_REQUEST_FILE: responseFile,
      } });
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ parts: Array<Record<string, unknown>> }>;
          }>,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
          )),
      );

      const requestResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: request.prompt }),
      });
      expect(requestResponse.status).toBe(202);
      const response = await waitFor(
        () => fs.readFile(responseFile, "utf8")
          .then((value) => JSON.parse(value.trim()))
          .catch(() => null) as Promise<Record<string, unknown> | null>,
        Boolean,
      );
      expect(response).toMatchObject({ id: 903, result: {} });
      expect(response).not.toHaveProperty("error");
      // Not the ACP permission outcome. Its members are `selected` and
      // `cancelled`; neither describes a child that ended.
      expect(response).not.toHaveProperty("result.outcome");
      const settled = await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers })
          .then((response) => response.json()) as Promise<{
            status: string;
            messages: Array<{ parts: Array<Record<string, unknown>> }>;
          }>,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === request.agentState
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: "success", agentState: request.agentState });
      expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json())).toEqual({ activity: "idle" });
    });
  }



  // Each of these turns delivers a `cursor/task` the bridge must ignore. The
  // turn is allowed to finish before the assertion, so a still-active child is
  // evidence the frame was processed and rejected — not that the test raced it.
  for (const ignored of [
    {
      prompt: "RUNNINGCURSORTASK",
      reason: "reports a non-terminal state",
    },
    {
      prompt: "OTHERSESSIONCURSORTASK",
      reason: "belongs to another ACP session",
    },
    {
      prompt: "UNKNOWNCURSORTASK",
      reason: "names a tool call that is not a live child",
    },
  ] as const) {
    test(`ignores a cursor/task that ${ignored.reason}`, async () => {
      const { base, headers } = await spawnBridge();
      const created = await nativeFetch(`${base}/session/create`, {
        method: "POST",
        headers,
      }).then((response) => response.json()) as { id: string };
      const read = async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ content?: string; parts: Array<Record<string, unknown>> }>;
        }>;
      const activity = async () => nativeFetch(`${base}/session/${created.id}/activity`, { headers })
        .then((response) => response.json()) as Promise<{ activity: string }>;

      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT" }),
      });
      await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
          )),
      );

      const ignoredResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: ignored.prompt }),
      });
      expect(ignoredResponse.status).toBe(202);
      // The marker is written after the frame on the same stream, so its
      // arrival is what makes "still active" below an observation, not a race.
      const held = await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) =>
            message.content?.includes("Cursor task frame delivered.") === true
          ),
      );
      const parts = held.messages.flatMap((message) => message.parts);
      expect(parts.find((part) => part.toolUseId === "cursor-subagent-1"))
        .toMatchObject({ agentState: "active" });
      expect(await activity()).toEqual({ activity: "working" });
      // An ignored frame must not invent a launch part for the id it named.
      expect(parts.some((part) => part.toolUseId === "cursor-never-seen-1")).toBe(false);
      const plain = parts.find((part) => part.toolUseId === "cursor-plain-tool-1");
      if (plain) expect(plain).not.toHaveProperty("agentState");

      // The same child still settles once a frame the bridge accepts arrives,
      // so the guard rejects the bad frame rather than the method.
      const finishResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "FINISHCURSORTASK" }),
      });
      expect(finishResponse.status).toBe(202);
      const settled = await waitFor(
        read,
        (value) => value.status === "idle"
          && value.messages.some((message) => message.parts.some((part) =>
            part.toolUseId === "cursor-subagent-1" && part.agentState === "finished"
          )),
      );
      expect(settled.messages.flatMap((message) => message.parts).find((part) =>
        part.toolUseId === "cursor-subagent-1"
      )).toMatchObject({ toolState: "success", agentState: "finished" });
      expect(await activity()).toEqual({ activity: "idle" });
    });
  }



  // The second case adds a terminal `status` to the *launch* result. Grok is
  // not observed sending one, but the launch tool completing is the spawn
  // succeeding, not the child ending — only `subagent_finished` is that. A
  // reading that settled on the launch result would strand a running child as
  // Finished and hand the session back as idle while it was still working.
  for (const launch of [
    { prompt: "BACKGROUNDSUBAGENT", label: "until its terminal notification" },
    { prompt: "BACKGROUNDSUBAGENTSTATUS", label: "past a completed launch result" },
  ] as const) {
  test(`tracks Grok's metadata-described sub-agent ${launch.label}`, async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: `env-grok-${launch.prompt}:tab-1` }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: `${launch.prompt}: validate` }),
    })).status).toBe(202);

    const active = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "active"
        )),
    );
    expect(active.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({
      type: "tool-invocation",
      toolName: "spawn_subagent",
      toolState: "success",
      agentState: "active",
      toolArgs: {
        variant: "Task",
        run_in_background: true,
        description: "Validate the implementation",
        subagent_type: "explore",
      },
    });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, {
      headers,
    }).then((response) => response.json())).toEqual({ activity: "working" });

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHSUBAGENT" }),
    })).status).toBe(202);

    const finished = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "finished"
        )),
    );
    expect(finished.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({ toolState: "success", agentState: "finished" });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, {
      headers,
    }).then((response) => response.json())).toEqual({ activity: "idle" });
  });
  }



  test("enriches a settled Cursor read while a same-kind sibling is still in flight", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-pending-sibling.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_PARALLEL_READS: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-pending-sibling:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_PENDING_SIBLING" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    const live = await waitFor(
      readSession,
      (value) => tools(value).some(
        (part) => part.toolUseId === "live-read-2"
          && part.toolTitle === "Read second.json (1 - 20)",
      ),
    );
    // `live-read-2` is in the index; `live-read-1` is not. The live pass has to
    // enrich the settled call from a unique output match and leave the pending
    // one generic — using the kind fallback here would stamp the wrong file
    // onto `live-read-1` permanently.
    expect(tools(live)).toEqual([
      expect.objectContaining({ toolUseId: "live-read-1", toolTitle: "Read File", toolState: "pending" }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
        toolState: "success",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).every((part) => part.toolTitle !== "Read File"),
    );
    // Both entries exist by the final pass, and each part keeps its own file:
    // the replay arrives in completion order, the reverse of the launch order
    // the transcript holds.
    expect(tools(settled)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read first.json (1 - 40)",
        toolArgs: { path: "/workspace/first.json" },
      }),
      expect.objectContaining({
        toolUseId: "live-read-2",
        toolTitle: "Read second.json (1 - 20)",
        toolArgs: { path: "/workspace/second.json" },
      }),
    ]);
  });



  test("enriches a settled Cursor read while a different-kind call is still in flight", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-pending-other.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-pending-other:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_PENDING_OTHER" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    const live = await waitFor(
      readSession,
      (value) => tools(value).some(
        (part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)",
      ),
    );
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
        toolState: "success",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-shell-1" && part.toolState === "success"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
      });
  });



  test("does not stamp a stale same-kind title on a live Cursor pass", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-stale-kind.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_STALE_KIND: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-stale-kind:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_STALE_KIND" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^load:/gm)?.length ?? 0) >= 1,
    );
    // The live window holds only the stale same-kind candidate, which has no
    // output hash. Kind fallback would stamp that file onto this part forever.
    await Bun.sleep(800);
    const live = await readSession();
    expect(live.status).toBe("running");
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read File",
        toolArgs: {},
        toolState: "success",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
      });
  });



  test("leaves a failed Cursor read generic on the live pass and recovers at the end", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-failed-no-output.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-failed-no-output:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_FAILED_NO_OUTPUT" }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const tools = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      value.messages[1]?.parts.filter((part) => part.type === "tool-invocation") ?? [];

    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => (value.match(/^load:/gm)?.length ?? 0) >= 1,
    );
    await Bun.sleep(800);
    const live = await readSession();
    expect(live.status).toBe("running");
    expect(tools(live)).toEqual([
      expect.objectContaining({
        toolUseId: "live-read-1",
        toolTitle: "Read File",
        toolArgs: {},
        toolState: "failure",
      }),
      expect.objectContaining({
        toolUseId: "live-shell-1",
        toolTitle: "Run safe command",
        toolState: "pending",
      }),
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);

    await fs.writeFile(holdTurnFile, "");
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle"
        && tools(value).some((part) => part.toolUseId === "live-read-1"
          && part.toolTitle === "Read package.json (1 - 80)"),
    );
    expect(tools(settled).find((part) => part.toolUseId === "live-read-1"))
      .toMatchObject({
        toolTitle: "Read package.json (1 - 80)",
        toolArgs: { path: "/workspace/package.json" },
        toolState: "failure",
      });
  });



  test.each([
    [
      "a structured turn is running",
      { requestId: "cursor-live-structured-1", outputSchema: { type: "object" } },
      {},
    ],
    ["the turn has no live budget left", {}, { ACP_MAX_LIVE_CURSOR_TOOL_REPLAYS: "0" }],
  ])("holds Cursor enrichment back to the final pass when %s", async (_label, body, extraEnv) => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "cursor-live-suppressed.log");
    const holdTurnFile = resolve(directory, "release-turn");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_REPLAY_CURSOR_TOOL_METADATA: "1",
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_HOLD_TURN_FILE: holdTurnFile,
        ...extraEnv,
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-suppressed:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_GENERIC_TOOLS_RUNNING", ...body }),
    });
    const readSession = async () =>
      nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
    const titles = (value: { messages: Array<{ parts: Array<Record<string, unknown>> }> }) =>
      (value.messages[1]?.parts ?? [])
        .filter((part) => part.type === "tool-invocation")
        .map((part) => part.toolTitle);

    await waitFor(readSession, (value) => titles(value).length === 2);
    // A structured turn forbids the silent re-bounding the join performs, and a
    // spent budget is what stops a long turn spawning a child per settled tool.
    // Either way no live child may start while the turn is still open.
    await Bun.sleep(1_200);
    expect(await fs.readFile(lifecycleFile, "utf8").catch(() => "")).not.toContain("load:");
    expect(await readSession().then(titles)).toEqual(["Read File", "grep"]);

    await fs.writeFile(holdTurnFile, "");
    // The final pass is never suppressed, so the turn still ends enriched.
    const settled = await waitFor(
      readSession,
      (value) => value.status === "idle" && titles(value).every((title) => title !== "Read File"),
    );
    expect(titles(settled)).toEqual([
      "Read package.json (1 - 80)",
      "grep --include=\"*.json\" \"scripts\"",
    ]);
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);
  });



  test("renders a placeholder when both file states exceed the inline limit", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-huge" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "HUGEEDIT: rewrite an oversized file" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "hugeedit-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff?.diff).toBe(
      "--- oversized.ts\n+++ oversized.ts\n@@ diff omitted: file state exceeded display limit @@",
    );
    expect(diff).toMatchObject({ filePath: "oversized.ts" });
    // Neither the file contents nor counts we cannot derive are retained.
    expect(diff?.before).toBeUndefined();
    expect(diff?.after).toBeUndefined();
    expect(diff?.additions).toBeUndefined();
    expect(diff?.deletions).toBeUndefined();
  });



  test("falls back to a bounded block diff when an edit exceeds the search distance", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-wide" }),
    }).then((response) => response.json()) as { id: string };

    const startedAt = Date.now();
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "WIDEEDIT: rewrite every line" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );
    // The unbounded search spent ~150ms of blocked read loop and ~340MB of heap
    // on an input this shape before discarding the result.
    expect(Date.now() - startedAt).toBeLessThan(3_000);

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "wide-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/wide.ts", additions: 4000, deletions: 4000 });
    const rendered = diff?.diff as string;
    // Shared prefix and suffix survive as context; everything between them is
    // one removed block followed by one added block.
    expect(rendered).toContain(" const keep = true;");
    expect(rendered).toContain(" export {};");
    expect(rendered.indexOf("-const before_0 = 0;")).toBeLessThan(rendered.indexOf("+const after_0 = 0;"));
    expect(rendered).toContain("-const before_3999 = 3999;");
    expect(rendered).toContain("+const after_3999 = 7998;");
  });



  test("ignores an empty supplied diff and renders the file states instead", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-empty" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "EMPTYDIFF: unfilled diff field" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "idle",
    );

    const tool = session.messages[1]?.parts.find((part) => part.toolUseId === "empty-1");
    const diff = tool?.toolDiff as Record<string, unknown> | undefined;
    expect(diff).toMatchObject({ filePath: "src/empty.ts", additions: 1, deletions: 1 });
    expect(diff?.diff).toContain("-const value = 1;");
    expect(diff?.diff).toContain("+const value = 2;");
  });



  test("retries a flattened error whose class name is not RetriableError", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-other-class.log");
    const { base, headers } = await spawnBridge({ env: {
      ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
      FAKE_ACP_COUNTER_FILE: counterFile,
      FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
      // The class name is whatever the provider's error carried. Matching only
      // `RetriableError` would leave every other name dead in the transcript.
      FAKE_ACP_FLATTENED_ERROR_NAME: "GoogleGenerativeAIFetchError",
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: unfamiliar error class",
        requestId: "resource-retry-class-1",
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle" || value.status === "error",
    );

    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();
    expect(session.messages.at(-1)?.content).toContain("Recovered and finished the original request.");
    expect(session.messages.at(-1)?.content).not.toContain("resource_exhausted");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });



  test("rolls back a keyed session when initial configuration fails", async () => {
    const directory = await temporaryDirectory();
    const failureFile = resolve(directory, "config-failed.log");
    const lifecycleFile = resolve(directory, "config-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_FAIL_CONFIG_ONCE_FILE: failureFile,
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      ACP_MAX_SESSIONS: "1",
    } });
    const create = () => nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        clientSessionKey: "env-1:configured-tab",
        reasoningId: "high",
      }),
    });

    const failed = await create();
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: "fake configuration failure" });

    const retried = await create();
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({
      composer: { selectedReasoningId: "high" },
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^start:/gm)?.length ?? 0) === 2,
    );
  });



  test("does not confirm a request while a cold session load is still preparing it", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "preparing-dispatch-lifecycle.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_LOAD_DELAY_MS: "800",
    } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}/status`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const prompt = nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:prepared", requestId: "preparing-1" }),
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^load:/gm)?.length ?? 0) === 1,
    );
    expect(await nativeFetch(
      `${bridge.base}/session/${created.id}/dispatch?requestId=preparing-1`,
      { headers: bridge.headers },
    ).then((response) => response.json())).toEqual({ dispatch: "unknown" });
    const duplicate = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:prepared", requestId: "preparing-1" }),
    });
    expect(duplicate.status).toBe(409);

    expect((await prompt).status).toBe(202);
    expect(await nativeFetch(
      `${bridge.base}/session/${created.id}/dispatch?requestId=preparing-1`,
      { headers: bridge.headers },
    ).then((response) => response.json())).toEqual({ dispatch: "dispatched" });
  });



  test("rejects unsupported vendor requests instead of acknowledging them", async () => {
    const directory = await temporaryDirectory();
    const responseFile = resolve(directory, "vendor-response.log");
    const bridge = await spawnBridge({ env: { FAKE_ACP_VENDOR_REQUEST_FILE: responseFile } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(created.status).toBe(201);
    const response = await waitFor(
      () => fs.readFile(responseFile, "utf8").then((value) => JSON.parse(value.trim())).catch(() => null) as Promise<Record<string, unknown> | null>,
      Boolean,
    );
    expect(response).toMatchObject({
      id: 901,
      error: { code: -32601, message: "Unsupported ACP client method: x.ai/ask_user_question" },
    });
    expect(response).not.toHaveProperty("result");
  });



  test("recovers structured JSON after thinking or commentary in the text channel", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const prompt = async (text: string, requestId: string) => {
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: text,
          requestId,
          outputSchema: { type: "object" },
        }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );
    };
    const readStructured = async (requestId: string) => nativeFetch(
      `${base}/session/${created.id}/structured-output?requestId=${requestId}`,
      { headers },
    ).then((response) => response.json()) as Promise<{ structuredOutput: { ok: boolean; value?: unknown } }>;

    await prompt(
      'DIRECT:The schema requires JSON. Weighing whether to embed it in CreatePlan.\n{"ok":true}',
      "prose-1",
    );
    expect((await readStructured("prose-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { ok: true } });

    await prompt("THOUGHT_THEN_JSON:{\"fromText\":true}", "thought-then-1");
    expect((await readStructured("thought-then-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { fromText: true } });

    await prompt("JSON_THEN_THOUGHT:{\"fromText\":true}", "json-then-thought-1");
    expect((await readStructured("json-then-thought-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { fromText: true } });

    await prompt(
      'DIRECT:<thinking>{"fromThought":true}</thinking>\n{"ok":true}',
      "tagged-thinking-1",
    );
    expect((await readStructured("tagged-thinking-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { ok: true } });

    await prompt(
      'DIRECT:{"ok":true}\n<thinking>{"fromThought":true}</thinking>',
      "json-then-tagged-1",
    );
    expect((await readStructured("json-then-tagged-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { ok: true } });

    // An annotated or run-on opening tag still marks the trace, so the report
    // outside it wins instead of the reasoning inside it.
    await prompt(
      'DIRECT:{"ok":true}\nReasoning:<thinking type="reflection">{"fromThought":true}</thinking>',
      "tagged-attributes-1",
    );
    expect((await readStructured("tagged-attributes-1")).structuredOutput)
      .toMatchObject({ ok: true, value: { ok: true } });
  });



  test("normalizes Cursor ACP config into composer state and applies patches", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as {
      id: string;
      composer: {
        models: Array<{ id: string; label: string; platform: string }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
        fastModeAvailable: boolean;
        selectedModeId?: string;
        modes: Array<{ id: string }>;
      };
    };
    expect(session.composer.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(session.composer.models[0]).toMatchObject({
      platform: "cursor",
      label: "Composer 2.5",
    });
    expect(session.composer.selectedModelId).toBe("composer-2.5");
    expect(session.composer.selectedReasoningId).toBe("medium");
    expect(session.composer.fastModeAvailable).toBe(true);
    expect(session.composer.selectedModeId).toBe("build");
    expect(JSON.stringify(session)).not.toContain("configOptions");
    expect(JSON.stringify(session)).not.toContain("_meta");

    const catalog = await nativeFetch(`${base}/global/models`, { headers })
      .then((response) => response.json()) as { models: Array<{ id: string }> };
    expect(catalog.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);

    const updated = await nativeFetch(`${base}/session/${session.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        modelId: "gpt-5.5",
        reasoningId: "high",
        fastMode: true,
        mode: "plan",
      }),
    });
    expect(updated.status).toBe(200);
    const composer = await updated.json() as {
      selectedModelId?: string;
      selectedReasoningId?: string;
      fastModeEnabled: boolean | null;
      selectedModeId?: string;
    };
    expect(composer.selectedModelId).toBe("gpt-5.5");
    expect(composer.selectedReasoningId).toBe("high");
    expect(composer.fastModeEnabled).toBe(true);
    expect(composer.selectedModeId).toBe("plan");
  });



  test("normalizes Grok ACP models and reasoning without leaking vendor wire", async () => {
    const { base, headers } = await spawnBridge({ env: { ACP_PROVIDER: "grok" } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const session = await created.json() as {
      id: string;
      composer: {
        models: Array<{ id: string; reasoning?: Array<{ id: string; label: string }> }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
      };
    };
    expect(session.composer.selectedModelId).toBe("grok-build");
    expect(session.composer.selectedReasoningId).toBe("high");
    expect(session.composer.models[0]?.reasoning?.map((option) => option.id)).toEqual(["low", "high", "xhigh"]);
    expect(JSON.stringify(session)).not.toContain("reasoningEfforts");

    const updated = await nativeFetch(`${base}/session/${session.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reasoningId: "low" }),
    });
    expect(updated.status).toBe(200);
    const composer = await updated.json() as { selectedReasoningId?: string };
    expect(composer.selectedReasoningId).toBe("low");
  });



  test("applies Grok vendor catalogue updates to session and global snapshots", async () => {
    const { base, headers } = await spawnBridge({ env: {
      ACP_PROVIDER: "grok",
      FAKE_ACP_EMIT_MODEL_UPDATE: "1",
    } });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "DIRECT:update models", requestId: "model-update" }),
    });
    expect(dispatched.status).toBe(202);

    const session = await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{
        status: string;
        composer: { selectedModelId?: string; models: Array<{ id: string }> };
      }>,
      (value) => value.status === "idle" && value.composer.models.some((model) => model.id === "grok-next"),
    );
    expect(session.composer.selectedModelId).toBe("grok-next");
    const catalog = await nativeFetch(`${base}/global/models`, { headers })
      .then((response) => response.json()) as { models: Array<{ id: string }> };
    expect(catalog.models.map((model) => model.id)).toContain("grok-next");
  });



  for (const acpProvider of ["cursor", "grok"] as const) {
    test(`sends and rehydrates workspace images for ${acpProvider}`, async () => {
      const workspace = await temporaryDirectory();
      const stateDirectory = await temporaryDirectory();
      const blocksFile = resolve(workspace, "prompt-blocks.log");
      const filename = "screen #1?.png";
      const imagePath = resolve(workspace, filename);
      await fs.writeFile(imagePath, ONE_PIXEL_PNG);
      const bridgeEnv = {
        ACP_PROVIDER: acpProvider,
        CWD: workspace,
        FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
        // Grok currently understates this capability but accepts the standard
        // image block; keep that compatibility case explicit in the harness.
        FAKE_ACP_IMAGE_CAPABILITY: acpProvider === "cursor" ? "true" : "false",
      };
      const first = await spawnBridge({ stateDirectory, env: bridgeEnv });
      const created = await nativeFetch(`${first.base}/session/create`, {
        method: "POST",
        headers: first.headers,
      }).then((response) => response.json()) as { id: string };

      const dispatched = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: first.headers,
        body: JSON.stringify({
          prompt: "DIRECT:describe it",
          requestId: "image-1",
          // Relative to the workspace, as a renderer pick from the file tree is.
          attachments: [{ type: "image", path: filename, filename }],
        }),
      });
      expect(dispatched.status).toBe(202);
      await waitFor(
        () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
          .then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );

      const blocks = JSON.parse((await fs.readFile(blocksFile, "utf8")).trim()) as Array<{
        type: string;
        text?: string;
        mimeType?: string;
        data?: string;
      }>;
      expect(blocks[0]).toMatchObject({ type: "text", text: "DIRECT:describe it" });
      // The bytes must reach the model natively; a path in the prompt text only
      // works if the agent happens to open it, and neither agent reads images
      // through its own file tools.
      expect(blocks[1]).toEqual({
        type: "image",
        mimeType: "image/png",
        data: ONE_PIXEL_PNG.toString("base64"),
      });

      const transcript = await nativeFetch(`${first.base}/session/${created.id}`, {
        headers: first.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      const user = transcript.messages.find((message) => message.role === "user");
      const filePart = user?.parts.find((part) => part.type === "file");
      // The encoded basename is pinned literally rather than recomputed with
      // `pathToFileURL`: restating the implementation would still pass against
      // the `file://${path}` template this replaced, which leaves `#` parsing as
      // a fragment and resolves the preview to the wrong file or none at all.
      // Only the temporary directory is derived, since it varies per run.
      expect(filePart).toEqual({
        type: "file",
        content: filename,
        fileUrl: `${pathToFileURL(workspace).href}/screen%20%231%3F.png`,
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
      });

      await stopChild(first.child);
      const restarted = await spawnBridge({ stateDirectory, env: bridgeEnv });
      const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
        headers: restarted.headers,
      }).then((response) => response.json()) as {
        messages: Array<{ role: string; parts: Array<Record<string, unknown>> }>;
      };
      expect(restored.messages.find((message) => message.role === "user")?.parts)
        .toContainEqual(filePart);
    });
  }

});
