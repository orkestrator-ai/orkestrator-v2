import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  nativeFetch,
  spawnBridge,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";

type SessionSnapshot = {
  status: string;
  messages: Array<{
    role?: string;
    content?: string;
    parts: Array<Record<string, unknown>>;
  }>;
};

describe("ACP Cursor background continuation", () => {
  test("keeps a spawn-echo cursor/task live and still settles on a later duration", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async (): Promise<SessionSnapshot> => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<SessionSnapshot>;

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORBACKGROUNDCHILD" }),
    })).status).toBe(202);

    const launched = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
        )),
    );
    expect(launched.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "cursor-subagent-1"
    )).toMatchObject({
      toolState: "success",
      agentState: "active",
      toolArgs: { agentId: "child-wait-1", durationMs: 31 },
    });
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHCURSORTASK" }),
    })).status).toBe(202);
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
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("does not wait for a background Task whose cursor/task duration is not the spawn echo", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "200",
        FAKE_ACP_COUNTER_FILE: counterFile,
      },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORTASK: summarize" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<SessionSnapshot>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-task-1" && part.agentState === "finished"
        )),
    );
    expect(settled.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "cursor-task-1"
    )).toMatchObject({ toolState: "success", agentState: "finished" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
  });

  test("holds the Cursor parent turn until the child transcript ends, then injects the result", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    const counterFile = resolve(directory, "prompts.log");
    const agentId = "child-wait-1";
    const childDir = resolve(transcripts, agentId);
    await fs.mkdir(childDir, { recursive: true });
    const jsonl = resolve(childDir, `${agentId}.jsonl`);

    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "8000",
        CURSOR_AGENT_TRANSCRIPTS_DIR: transcripts,
        FAKE_ACP_COUNTER_FILE: counterFile,
      },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };
    const read = async (): Promise<SessionSnapshot> => nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json()) as Promise<SessionSnapshot>;

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORBACKGROUNDCHILD" }),
    })).status).toBe(202);

    await waitFor(
      read,
      (value) => value.status === "running"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
        )),
    );

    await fs.writeFile(
      jsonl,
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "All tests passed at HEAD." }] },
      })}\n${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
    );

    const settled = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "finished"
        )),
    );
    expect(settled.messages.some((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
      && message.content.includes("All tests passed at HEAD.")
    )).toBe(true);
    expect(settled.messages.some((message) =>
      message.role === "assistant"
      && message.content?.includes("Validation passed.") === true
    )).toBe(true);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("continues once with a timeout note when the Cursor child transcript never ends", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    await fs.mkdir(transcripts, { recursive: true });
    const counterFile = resolve(directory, "prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "50",
        CURSOR_AGENT_TRANSCRIPTS_DIR: transcripts,
        FAKE_ACP_COUNTER_FILE: counterFile,
      },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CURSORBACKGROUNDCHILD" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<SessionSnapshot>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "failed"
        )),
    );
    expect(settled.messages.some((message) =>
      message.role === "user"
      && message.content?.includes("Status: timeout") === true
    )).toBe(true);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
  });

  test("does not auto-continue Grok even when the Cursor wrapper is enabled", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_PROVIDER: "grok",
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "50",
        FAKE_ACP_COUNTER_FILE: counterFile,
      },
    });
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-grok-no-cursor-continue:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "BACKGROUNDSUBAGENT: validate" }),
    })).status).toBe(202);

    const active = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<SessionSnapshot>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "active"
        )),
    );
    expect(active.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({ toolState: "success", agentState: "active" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });

    expect((await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "FINISHSUBAGENT" }),
    })).status).toBe(202);
    const finished = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<SessionSnapshot>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "grok-subagent-tool-1" && part.agentState === "finished"
        )),
    );
    expect(finished.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "grok-subagent-tool-1"
    )).toMatchObject({ toolState: "success", agentState: "finished" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
  });
});
