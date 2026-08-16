import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  children,
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



  test("drops a persisted model id that is blank, oversized, or not a string", async () => {
    const stateDirectory = await temporaryDirectory();
    const assistantMessage = (id: string, modelId: unknown) => ({
      id,
      role: "assistant",
      content: id,
      parts: [{
        type: "text",
        content: id,
        sourcePartId: `${id}:0`,
        sourceMessageId: id,
      }],
      createdAt: "2026-08-01T00:00:00.000Z",
      modelId,
    });
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [{
          id: "session-model-ids",
          clientSessionKey: "env-1:tab-1",
          acpSessionId: "acp-session-model-ids",
          status: "idle",
          revision: 4,
          structured: [],
          promptJournal: [],
          messages: [
            assistantMessage("kept", "  gpt-5.5  "),
            assistantMessage("blank", "   "),
            // One byte past the bound the live composer enforces. An identifier
            // must be dropped rather than shortened into one that matches no
            // catalogue entry.
            assistantMessage("oversized", "m".repeat(1025)),
            assistantMessage("nonstring", 42),
            assistantMessage("absent", undefined),
          ],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-model-ids`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      messages: Array<Record<string, unknown>>;
    };

    expect(session.messages.map((message) => message.id))
      .toEqual(["kept", "blank", "oversized", "nonstring", "absent"]);
    // Trimmed and kept, then dropped outright for every unusable form.
    expect(session.messages[0]?.modelId).toBe("gpt-5.5");
    expect(session.messages.slice(1).map((message) => "modelId" in message))
      .toEqual([false, false, false, false]);
  });



  // The rail and the nested agent row both key off `parentTaskUseId`, so losing
  // it across a bridge restart would silently flatten a restored transcript
  // back into unattributed top-level tool rows.
  test("restores nested child parentTaskUseId after a bridge restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-nested-restart:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "NESTEDSUBAGENT: inspect" }),
    })).status).toBe(202);

    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    // Persistence is debounced, so the restart has to wait for the writer
    // rather than for the turn that produced the parts.
    await waitFor(
      () => fs.readFile(resolve(stateDirectory, "state.json"), "utf8")
        .then((contents) => contents)
        .catch(() => ""),
      (contents) => contents.includes("cursor-child-grep-1"),
    );
    await stopChild(first.child);

    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    const restoredParts = restored.messages.flatMap((message) => message.parts);
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-grep-1"))
      .toMatchObject({ parentTaskUseId: "cursor-subagent-1" });
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-claude-5"))
      .toMatchObject({ parentTaskUseId: "cursor-subagent-1" });
    expect(restoredParts.find((part) => part.toolUseId === "cursor-child-self-7"))
      .not.toHaveProperty("parentTaskUseId");
    // The launch part still has to be findable, or the restored children would
    // have a parent id pointing at nothing.
    expect(restoredParts.find((part) => part.toolUseId === "cursor-subagent-1"))
      .toMatchObject({ toolName: "task" });
  });



  test("bounds replay metadata before publishing and persists the trimmed transcript", async () => {
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(stateDirectory, "cursor-replay-bounds.log");
    const maximumTranscriptBytes = 1024 * 1024;
    const first = await spawnBridge({
      stateDirectory,
      env: {
        ACP_MAX_TRANSCRIPT_BYTES: String(maximumTranscriptBytes),
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_REPLAY_CURSOR_OVERSIZED_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-bounds:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "CURSOR_OVERSIZED_REPLAY" }),
    });
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (value) => value.includes("stop:"),
    );
    const session = await nativeFetch(`${first.base}/session/${created.id}`, {
      headers: first.headers,
    }).then((response) => response.json()) as {
      status: string;
      baseIndex: number;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(session.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThanOrEqual(maximumTranscriptBytes);
    expect(session.baseIndex).toBeGreaterThan(0);
    expect(session.messages.flatMap((message) => message.parts).some(
      (part) => typeof part.content === "string"
        && part.content.includes("Earlier steps in this response were dropped"),
    )).toBe(true);
    // Both bounds evict oldest-first, so the calls that survive the budget are
    // the *newest* ones — the metadata the live turn is most likely to need.
    // `replay-huge-b` is the one dropped, and its live part keeps the generic
    // title rather than inheriting a surviving neighbour's filename.
    const retainedTool = session.messages.flatMap((message) => message.parts).find(
      (part) => part.toolTitle === "Read huge-c.json",
    );
    expect(retainedTool?.toolUseId).toBe("live-huge-c");
    expect((retainedTool?.toolArgs as { payload?: string } | undefined)?.payload?.length)
      .toBe(480 * 1024);
    expect(session.messages.flatMap((message) => message.parts).find(
      (part) => part.toolUseId === "live-huge-b",
    )).toMatchObject({ toolTitle: "Read File", toolArgs: {} });

    const persisted = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        sessions: Array<{
          status: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>;
      },
      (value) => value.sessions[0]?.messages.flatMap((message) => message.parts).some(
        (part) => part.toolTitle === "Read huge-c.json",
      ) === true,
    );
    expect(persisted.sessions[0]?.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(persisted.sessions[0]?.messages)))
      .toBeLessThanOrEqual(maximumTranscriptBytes);

    await stopChild(first.child);
    const restarted = await spawnBridge({
      stateDirectory,
      env: { ACP_MAX_TRANSCRIPT_BYTES: String(maximumTranscriptBytes) },
    });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(restored.status).toBe("idle");
    expect(Buffer.byteLength(JSON.stringify(restored.messages))).toBeLessThanOrEqual(maximumTranscriptBytes);
  });



  test("bounds all persisted sessions while retaining structured output across restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const maximumStateBytes = 2 * 1024 * 1024;
    const env = { ACP_MAX_STATE_FILE_BYTES: String(maximumStateBytes) };
    const first = await spawnBridge({ stateDirectory, env });

    const largeTranscript = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-persist:large-transcript" }),
    }).then((response) => response.json()) as { id: string };
    await nativeFetch(`${first.base}/session/${largeTranscript.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "BIGTOOL: pressure the shared state file" }),
    });
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${largeTranscript.id}/status`, {
        headers: first.headers,
      }).then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    const structuredSession = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-persist:structured" }),
    }).then((response) => response.json()) as { id: string };
    const data = "s".repeat(400 * 1024);
    await nativeFetch(`${first.base}/session/${structuredSession.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({
        prompt: `DIRECT:${JSON.stringify({ data })}`,
        requestId: "persisted-structured-output",
        outputSchema: {
          type: "object",
          properties: { data: { type: "string" } },
          required: ["data"],
        },
      }),
    });
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${structuredSession.id}/status`, {
        headers: first.headers,
      }).then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    await stopChild(first.child);
    const stateFile = resolve(stateDirectory, "state.json");
    expect((await fs.stat(stateFile)).size).toBeLessThanOrEqual(maximumStateBytes);

    const second = await spawnBridge({ stateDirectory, env });
    for (const sessionId of [largeTranscript.id, structuredSession.id]) {
      const response = await nativeFetch(`${second.base}/session/${sessionId}/messages`, {
        headers: second.headers,
      });
      expect(response.status).toBe(200);
      const restored = await response.json() as {
        messages: unknown[];
        messageWindow: { truncated: boolean };
      };
      expect(restored.messages.length).toBeGreaterThan(0);
      expect(restored.messageWindow.truncated).toBe(true);
    }

    const structured = await nativeFetch(
      `${second.base}/session/${structuredSession.id}/structured-output?requestId=persisted-structured-output`,
      { headers: second.headers },
    ).then((response) => response.json()) as {
      structuredOutput: { ok: boolean; value?: { data?: string } } | null;
    };
    expect(structured.structuredOutput?.ok).toBe(true);
    expect(structured.structuredOutput?.value?.data?.length).toBe(data.length);
  });



  test("drops malformed persisted tool parts on load", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [{
          id: "session-malformed",
          clientSessionKey: "env-1:tab-malformed",
          acpSessionId: "acp-session-malformed",
          status: "idle",
          revision: 2,
          structured: [],
          promptJournal: [],
          messages: [{
            id: "message-1",
            role: "assistant",
            content: "",
            parts: [
              { type: "tool-invocation", content: "No id", sourcePartId: "x", sourceMessageId: "message-1", toolState: "success" },
              { type: "tool-invocation", content: "Numeric id", sourcePartId: "y", sourceMessageId: "message-1", toolUseId: 42, toolState: "success" },
              { type: "tool-invocation", content: "Valid", sourcePartId: "z", sourceMessageId: "message-1", toolUseId: "ok-1", toolState: "success" },
              { type: "bogus", content: "Unknown type" },
            ],
            createdAt: "2026-08-01T00:00:00.000Z",
          }],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-malformed`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(session.messages[0]?.parts).toEqual([{
      type: "tool-invocation",
      content: "Valid",
      sourcePartId: "z",
      sourceMessageId: "message-1",
      toolUseId: "ok-1",
      toolState: "success",
    }]);
  });



  test("reports a turn lost to a bridge restart as unknown, not dispatched", async () => {
    const directory = await temporaryDirectory();
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({
      stateDirectory,
      env: { FAKE_ACP_HOLD_TURN_FILE: resolve(directory, "release-turn") },
    });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    // The fake agent holds this turn open, so the journal persists it as
    // accepted and the restart below rewrites that record to ambiguous.
    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({
        prompt: "CURSOR_GENERIC_TOOLS_RUNNING",
        requestId: "in-flight-1",
      }),
    })).status).toBe(202);
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "running",
    );
    // SIGKILL, not SIGTERM. A graceful stop rejects the in-flight prompt RPC,
    // and that rejection journals the turn as failed — which is a real answer
    // ("it reached the agent and ended"). Only a process that dies without
    // running any handler leaves the record genuinely unresolved.
    const exited = new Promise<void>((resolvePromise) =>
      first.child.once("exit", () => resolvePromise()));
    first.child.kill("SIGKILL");
    await exited;
    children.delete(first.child);

    const second = await spawnBridge({ stateDirectory });
    await nativeFetch(`${second.base}/session/create`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    // The record survived, but it records the ambiguity rather than resolving
    // it. Answering "dispatched" here would let a caller drop a prompt that
    // this process will never run.
    expect(await nativeFetch(
      `${second.base}/session/${created.id}/dispatch?requestId=in-flight-1`,
      { headers: second.headers },
    ).then((response) => response.json())).toEqual({ dispatch: "unknown" });
  });



  test("quarantines an unusable state file instead of refusing to start", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");

    // Seed a real state file so the restart path is genuine, then corrupt it.
    const seeded = await spawnBridge({ stateDirectory });
    await nativeFetch(`${seeded.base}/session/create`, {
      method: "POST",
      headers: seeded.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    await waitFor(() => fs.readFile(stateFile, "utf8").catch(() => ""), Boolean);
    await stopChild(seeded.child);
    await fs.writeFile(stateFile, "{ this is not json");

    const restarted = await spawnBridge({ stateDirectory });
    expect((await nativeFetch(`${restarted.base}/global/health`)).ok).toBe(true);
    // Started clean: the old client key no longer resolves to a session.
    const created = await nativeFetch(`${restarted.base}/session/create`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    expect(created.status).toBe(201);
    const quarantined = await fs.readdir(stateDirectory);
    expect(quarantined.some((entry) => entry.includes("corrupt"))).toBe(true);
    // The damaged bytes are moved aside, not silently rewritten in place.
    expect(await fs.readFile(stateFile, "utf8")).not.toBe("{ this is not json");
  });



  test("restores a normalized composer across a bridge restart", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");
    const seeded = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${seeded.base}/session/create`, {
      method: "POST",
      headers: seeded.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    await waitFor(() => fs.readFile(stateFile, "utf8").catch(() => ""), Boolean);
    await stopChild(seeded.child);

    // The persisted-state validator is deliberately strict, so a healthy
    // round-trip has to be asserted too: a validator stricter than the
    // normalizer that produced the state would silently reset every composer.
    const restarted = await spawnBridge({ stateDirectory });
    const restored = await nativeFetch(`${restarted.base}/session/${created.id}`, {
      headers: restarted.headers,
    }).then((response) => response.json()) as {
      composer: {
        models: Array<{ id: string }>;
        selectedModelId?: string;
        selectedReasoningId?: string;
        modes: Array<{ id: string }>;
      };
    };
    expect(restored.composer.models.map((model) => model.id)).toEqual(["composer-2.5", "gpt-5.5"]);
    expect(restored.composer.selectedModelId).toBe("composer-2.5");
    expect(restored.composer.selectedReasoningId).toBe("medium");
    expect(restored.composer.modes.map((mode) => mode.id)).toEqual(["build", "plan"]);
    expect((await fs.readdir(stateDirectory)).some((entry) => entry.includes("corrupt"))).toBe(false);
  });



  test("resets one malformed composer without discarding its sibling sessions", async () => {
    const stateDirectory = await temporaryDirectory();
    const stateFile = resolve(stateDirectory, "state.json");
    const seeded = await spawnBridge({ stateDirectory });
    const [healthy, damaged] = await Promise.all([
      nativeFetch(`${seeded.base}/session/create`, {
        method: "POST",
        headers: seeded.headers,
        body: JSON.stringify({ clientSessionKey: "env-1:healthy" }),
      }).then((response) => response.json()) as Promise<{ id: string }>,
      nativeFetch(`${seeded.base}/session/create`, {
        method: "POST",
        headers: seeded.headers,
        body: JSON.stringify({ clientSessionKey: "env-1:damaged" }),
      }).then((response) => response.json()) as Promise<{ id: string }>,
    ]);
    await waitFor(
      () => fs.readFile(stateFile, "utf8").catch(() => ""),
      (contents) => contents.includes(healthy.id) && contents.includes(damaged.id),
    );
    await stopChild(seeded.child);

    const persisted = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
      sessions: Array<{ id: string; sessionConfig?: unknown; composer?: unknown }>;
    };
    const target = persisted.sessions.find((session) => session.id === damaged.id)!;
    target.sessionConfig = { composer: {}, wire: {} };
    delete target.composer;
    await fs.writeFile(stateFile, JSON.stringify(persisted));

    // Composer configuration is a cache the next session/load rebuilds. Losing
    // it must not take the transcript, the client-key mapping or the prompt
    // journal of every *other* session with it.
    const restarted = await spawnBridge({ stateDirectory });
    const survivor = await nativeFetch(`${restarted.base}/session/${healthy.id}`, {
      headers: restarted.headers,
    });
    expect(survivor.status).toBe(200);
    expect((await survivor.json() as { composer: { models: unknown[] } }).composer.models)
      .toHaveLength(2);
    const reset = await nativeFetch(`${restarted.base}/session/${damaged.id}`, {
      headers: restarted.headers,
    });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ composer: { models: [], modes: [] } });
    // Nothing was quarantined: the file itself was never unreadable.
    expect((await fs.readdir(stateDirectory)).some((entry) => entry.includes("corrupt"))).toBe(false);
    // The damaged session kept its durable identity, so its key still resolves.
    const rebound = await nativeFetch(`${restarted.base}/session/create`, {
      method: "POST",
      headers: restarted.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:damaged" }),
    });
    expect(await rebound.json()).toMatchObject({ id: damaged.id });
  });



  test("starts clean when the state file belongs to another provider", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({ version: 1, provider: "grok", sessions: [] }),
    );
    const bridge = await spawnBridge({ stateDirectory });
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    });
    expect(created.status).toBe(201);
  });



  // A v1 file is what every already-installed bridge left on disk. Its parts
  // use the pre-consolidation `{ type: "reasoning", text }` wire shape, which
  // the renderer no longer converts, so the load path has to upgrade them or
  // the restored transcript renders as empty rows.
  test("upgrades v1 persisted messages to the neutral part shape", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 1,
        provider: "cursor",
        sessions: [{
          id: "session-v1",
          clientSessionKey: "env-1:tab-1",
          acpSessionId: "acp-session-v1",
          status: "idle",
          revision: 7,
          structured: [],
          promptJournal: [],
          messages: [
            {
              id: "message-user",
              role: "user",
              content: "Do the work",
              parts: [{ type: "text", text: "Do the work" }],
              createdAt: "2026-08-01T00:00:00.000Z",
            },
            {
              id: "message-assistant",
              role: "assistant",
              content: "approved:once",
              parts: [
                { type: "reasoning", text: "Checking permission. " },
                { type: "text", text: "approved:once" },
              ],
              createdAt: "2026-08-01T00:00:01.000Z",
            },
          ],
        }],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const session = await nativeFetch(`${bridge.base}/session/session-v1`, {
      headers: bridge.headers,
    }).then((response) => response.json()) as {
      revision: number;
      messages: Array<{
        id: string;
        parts: Array<Record<string, unknown>>;
      }>;
    };

    expect(session.revision).toBe(7);
    expect(session.messages.map((message) => message.id))
      .toEqual(["message-user", "message-assistant"]);
    // `reasoning` becomes `thinking`, `text` becomes `content`, and the part
    // identity the renderer keys off is synthesized rather than left absent.
    expect(session.messages[1]?.parts).toEqual([
      {
        type: "thinking",
        content: "Checking permission. ",
        sourcePartId: "message-assistant:0",
        sourceMessageId: "message-assistant",
      },
      {
        type: "text",
        content: "approved:once",
        sourcePartId: "message-assistant:1",
        sourceMessageId: "message-assistant",
      },
    ]);
    expect(session.messages[0]?.parts).toEqual([
      {
        type: "text",
        content: "Do the work",
        sourcePartId: "message-user:0",
        sourceMessageId: "message-user",
      },
    ]);

    // Loading alone does not rewrite the file; the next persist does, and it
    // must write the current shape with upgraded parts so this migration runs only once.
    const createdAfterLoad = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-2" }),
    });
    expect(createdAfterLoad.status).toBe(201);

    const rewritten = await waitFor(
      async () => JSON.parse(
        await fs.readFile(resolve(stateDirectory, "state.json"), "utf8"),
      ) as {
        version: number;
        sessions: Array<{ id: string; messages: Array<{ parts: Array<{ type: string }> }> }>;
      },
      (value) => value.version === 3,
    );
    expect(
      rewritten.sessions
        .find((persisted) => persisted.id === "session-v1")
        ?.messages[1]?.parts.map((part) => part.type),
    ).toEqual(["thinking", "text"]);
  });

});
