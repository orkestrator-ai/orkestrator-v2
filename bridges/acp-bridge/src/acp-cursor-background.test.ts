import { beforeAll, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
      toolArgs: { agentId: "child-wait-1" },
    });
    expect((launched.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "cursor-subagent-1"
    )?.toolArgs as { durationMs?: unknown } | undefined)?.durationMs).toBeUndefined();
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
    )).toMatchObject({
      toolState: "success",
      agentState: "finished",
      toolArgs: { durationMs: 84 },
    });
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

  test("continues with a failed status when the child transcript is aborted", async () => {
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
        message: { content: [{ type: "text", text: "Stopped before finishing." }] },
      })}\n${JSON.stringify({ type: "turn_ended", status: "aborted" })}\n`,
    );

    const settled = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "failed"
        )),
    );
    expect(settled.messages.some((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
      && message.content.includes("Status: failed") === true
      && message.content.includes("Status: finished") !== true
    )).toBe(true);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
  });

  test("cancels the parent wait without injecting a continuation", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    await fs.mkdir(transcripts, { recursive: true });
    const counterFile = resolve(directory, "prompts.log");
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

    expect((await nativeFetch(`${base}/session/${created.id}/cancel`, {
      method: "POST",
      headers,
    })).status).toBe(202);

    const settled = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "failed"
        )),
    );
    expect(settled.messages.some((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
    )).toBe(false);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "idle" });
  });

  test("resolves the default homedir transcript root when no override is set", async () => {
    const directory = await temporaryDirectory();
    const fakeHome = resolve(directory, "home");
    const cwd = resolve(directory, "project");
    await fs.mkdir(cwd);
    const slug = cwd.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\//g, "-");
    const agentId = "child-wait-1";
    const childDir = resolve(
      fakeHome,
      ".cursor",
      "projects",
      slug,
      "agent-transcripts",
      agentId,
    );
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(
      resolve(childDir, `${agentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Default path reached." }] },
      })}\n${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
    );
    const counterFile = resolve(directory, "prompts.log");

    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "8000",
        HOME: fakeHome,
        CWD: cwd,
        CURSOR_AGENT_TRANSCRIPTS_DIR: undefined,
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
        && value.messages.some((message) =>
          message.role === "user"
          && message.content?.includes("Default path reached.") === true
        ),
    );
    expect(settled.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "cursor-subagent-1"
    )).toMatchObject({ agentState: "finished" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual([
      "prompt",
      "prompt",
    ]);
  });

  test("stops waiting after the continuation cap even if a new background child is still live", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    const counterFile = resolve(directory, "prompts.log");
    const continuationLimit = 4;
    for (let index = 1; index <= continuationLimit + 1; index += 1) {
      const agentId = `child-wait-${index}`;
      const childDir = resolve(transcripts, agentId);
      await fs.mkdir(childDir, { recursive: true });
      await fs.writeFile(
        resolve(childDir, `${agentId}.jsonl`),
        `${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
      );
    }

    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "8000",
        CURSOR_AGENT_TRANSCRIPTS_DIR: transcripts,
        FAKE_ACP_BACKGROUND_RELAUNCH: "1",
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
          part.toolUseId === `cursor-subagent-${continuationLimit + 1}`
          && part.agentState === "active"
        )),
    );
    const parts = settled.messages.flatMap((message) => message.parts);
    for (let index = 1; index <= continuationLimit; index += 1) {
      expect(parts.find((part) => part.toolUseId === `cursor-subagent-${index}`))
        .toMatchObject({ agentState: "finished" });
    }
    expect(settled.messages.filter((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
    )).toHaveLength(continuationLimit);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(
      Array.from({ length: continuationLimit + 1 }, () => "prompt"),
    );
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });
  });

  test("does not wait for a live Cursor Task that never reported an agentId", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    await fs.mkdir(transcripts, { recursive: true });
    const counterFile = resolve(directory, "prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "200",
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
      body: JSON.stringify({ prompt: "CURSORBACKGROUNDNOID" }),
    })).status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<SessionSnapshot>,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.toolUseId === "cursor-subagent-1" && part.agentState === "active"
        )),
    );
    expect(settled.messages.some((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
    )).toBe(false);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });
  });

  test("projects child JSONL tool_use into the parent Task card while the child is live", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    const agentId = "child-wait-1";
    const childDir = resolve(transcripts, agentId);
    await fs.mkdir(childDir, { recursive: true });
    const jsonl = resolve(childDir, `${agentId}.jsonl`);

    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "1",
        ACP_CURSOR_BACKGROUND_WAIT_MS: "8000",
        CURSOR_AGENT_TRANSCRIPTS_DIR: transcripts,
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
        message: { content: [
          { type: "text", text: "Checking the suite." },
          { type: "tool_use", name: "Read", input: { path: "package.json" } },
        ] },
      })}\n`,
    );

    const live = await waitFor(
      read,
      (value) => value.messages.some((message) => message.parts.some((part) =>
        part.parentTaskUseId === "cursor-subagent-1"
        && part.toolName === "Read"
        && part.toolState === "pending"
      )),
    );
    expect(live.messages.flatMap((message) => message.parts).find((part) =>
      part.parentTaskUseId === "cursor-subagent-1" && part.type === "text"
    )).toMatchObject({ content: "Checking the suite." });

    await fs.appendFile(
      jsonl,
      `${JSON.stringify({ type: "turn_ended", status: "success" })}\n`,
    );

    const settled = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.parentTaskUseId === "cursor-subagent-1"
          && part.toolName === "Read"
          && part.toolState === "success"
        )),
    );
    expect(settled.messages.flatMap((message) => message.parts).find((part) =>
      part.toolUseId === "cursor-subagent-1"
    )).toMatchObject({ agentState: "finished" });
  });

  test("hydrates child JSONL into the Task card on session GET without holding the parent turn", async () => {
    const directory = await temporaryDirectory();
    const transcripts = resolve(directory, "transcripts");
    const agentId = "child-wait-1";
    const childDir = resolve(transcripts, agentId);
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(
      resolve(childDir, `${agentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "text", text: "Checking the suite." },
          { type: "tool_use", name: "Read", input: { path: "package.json" } },
        ] },
      })}\n`,
    );

    const { base, headers } = await spawnBridge({
      env: {
        ACP_CURSOR_BACKGROUND_CONTINUE: "0",
        CURSOR_AGENT_TRANSCRIPTS_DIR: transcripts,
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

    const hydrated = await waitFor(
      read,
      (value) => value.status === "idle"
        && value.messages.some((message) => message.parts.some((part) =>
          part.parentTaskUseId === "cursor-subagent-1"
          && part.toolName === "Read"
          && part.toolState === "pending"
        )),
    );
    expect(hydrated.messages.flatMap((message) => message.parts).find((part) =>
      part.parentTaskUseId === "cursor-subagent-1" && part.type === "text"
    )).toMatchObject({ content: "Checking the suite." });
    expect(hydrated.messages.some((message) =>
      message.role === "user"
      && message.content?.startsWith("Background subagent finished.") === true
    )).toBe(false);
    expect(await nativeFetch(`${base}/session/${created.id}/activity`, { headers })
      .then((response) => response.json())).toEqual({ activity: "working" });
  });
});

describe("ACP Cursor transcript records", () => {
  let cursorTranscriptTerminalState: (contents: string) => "finished" | "failed" | undefined;
  let cursorTranscriptRoot: (cwd?: string) => string;
  let cursorChildTranscriptPath: (agentId: string, cwd?: string) => string | undefined;
  let parseCursorChildTranscriptParts: typeof import("./acp-cursor-transcript-parts.js").parseCursorChildTranscriptParts;
  let MAX_CURSOR_CHILD_PARTS: number;

  beforeAll(async () => {
    process.env.ACP_PROVIDER ??= "cursor";
    ({
      cursorTranscriptTerminalState,
      cursorTranscriptRoot,
      cursorChildTranscriptPath,
    } = await import("./acp-cursor-background.js"));
    ({ parseCursorChildTranscriptParts } = await import("./acp-cursor-transcript-parts.js"));
    ({ MAX_CURSOR_CHILD_PARTS } = await import("./acp-context.js"));
  });

  test("maps success and missing status to finished, aborted and unknown to failed", () => {
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "turn_ended", status: "success" })}\n`))
      .toBe("finished");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "turn_ended" })}\n`))
      .toBe("finished");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "turn_ended", status: "aborted" })}\n`))
      .toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "turn_ended", status: "abort" })}\n`))
      .toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "result", subtype: "error" })}\n`))
      .toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "turn_ended", status: "running" })}\n`))
      .toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({ type: "assistant", status: "success" })}\n`))
      .toBeUndefined();
  });

  test("treats is_error and a present error field as failed", () => {
    expect(cursorTranscriptTerminalState(`${JSON.stringify({
      type: "turn_ended",
      status: "success",
      is_error: true,
    })}\n`)).toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({
      type: "turn_ended",
      status: "success",
      error: "child crashed",
    })}\n`)).toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({
      type: "result",
      error: { message: "tool failed" },
    })}\n`)).toBe("failed");
    expect(cursorTranscriptTerminalState(`${JSON.stringify({
      type: "turn_ended",
      status: "success",
      error: null,
    })}\n`)).toBe("finished");
  });

  test("builds the default homedir transcript path from the working directory", () => {
    const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    try {
      expect(cursorTranscriptRoot("/Users/foo/bar")).toBe(
        join(homedir(), ".cursor", "projects", "Users-foo-bar", "agent-transcripts"),
      );
      expect(cursorChildTranscriptPath("abc-123", "/Users/foo/bar")).toBe(
        join(
          homedir(),
          ".cursor",
          "projects",
          "Users-foo-bar",
          "agent-transcripts",
          "abc-123",
          "abc-123.jsonl",
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
    }
  });

  test("projects assistant text and tool_use into nested Task parts", () => {
    const contents = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "go" }] } }),
      JSON.stringify({
        type: "assistant",
        message: { content: [
          { type: "text", text: "Checking the suite." },
          { type: "tool_use", name: "Read", input: { path: "package.json" } },
        ] },
      }),
      JSON.stringify({ type: "turn_ended", status: "success" }),
    ].join("\n");

    const live = parseCursorChildTranscriptParts(
      contents,
      "cursor-subagent-1",
      "child-wait-1",
      "message-1",
      "live",
    );
    expect(live).toEqual([
      expect.objectContaining({
        type: "text",
        content: "Checking the suite.",
        parentTaskUseId: "cursor-subagent-1",
        sourcePartId: "cursor-jsonl:child-wait-1:0:0",
      }),
      expect.objectContaining({
        type: "tool-invocation",
        toolName: "Read",
        toolState: "pending",
        parentTaskUseId: "cursor-subagent-1",
        toolArgs: { path: "package.json" },
      }),
    ]);

    const ended = parseCursorChildTranscriptParts(
      contents,
      "cursor-subagent-1",
      "child-wait-1",
      "message-1",
      "ended",
    );
    expect(ended.find((part) => part.type === "tool-invocation")).toMatchObject({
      toolState: "success",
    });
  });

  // A child that died mid-tool never produced a result. Reporting that tool as
  // successful would claim work the sub-agent never finished.
  test("marks the trailing tool of an abandoned child as failed, not successful", () => {
    const contents = [
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Grep", input: { pattern: "todo" } }] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.ts" } }] },
      }),
    ].join("\n");

    const abandoned = parseCursorChildTranscriptParts(
      contents,
      "cursor-subagent-1",
      "child-wait-1",
      "message-1",
      "abandoned",
    );
    expect(abandoned.map((part) => part.type === "tool-invocation" && part.toolState))
      .toEqual(["success", "failure"]);
    expect(abandoned.at(-1)).toMatchObject({
      toolName: "Read",
      toolError: "The sub-agent ended before this tool reported a result",
    });

    const live = parseCursorChildTranscriptParts(
      contents,
      "cursor-subagent-1",
      "child-wait-1",
      "message-1",
      "live",
    );
    expect(live.map((part) => part.type === "tool-invocation" && part.toolState))
      .toEqual(["success", "pending"]);
    expect(live.at(-1)).not.toHaveProperty("toolError");
  });

  test("keeps only the most recent parts once the child exceeds the projection cap", () => {
    const records: string[] = [];
    for (let index = 0; index < MAX_CURSOR_CHILD_PARTS + 20; index += 1) {
      records.push(JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: `Tool${index}`, input: {} }] },
      }));
    }

    const parts = parseCursorChildTranscriptParts(
      records.join("\n"),
      "cursor-subagent-1",
      "child-wait-1",
      "message-1",
      "ended",
    );

    expect(parts).toHaveLength(MAX_CURSOR_CHILD_PARTS);
    // The tail is what matters: the oldest 20 tools are dropped, not the newest.
    expect(parts[0]).toMatchObject({ toolName: "Tool20" });
    expect(parts.at(-1)).toMatchObject({
      toolName: `Tool${MAX_CURSOR_CHILD_PARTS + 19}`,
    });
  });

  test("rejects an agentId that would escape the transcript root", () => {
    const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
    process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = "/tmp/cursor-transcripts";
    try {
      expect(cursorChildTranscriptPath("child-wait-1")).toBe(
        join("/tmp/cursor-transcripts", "child-wait-1", "child-wait-1.jsonl"),
      );
      for (const hostile of [
        "../../../../etc/passwd",
        "..",
        "a/../../b",
        "nested/child",
        "back\\slash",
        "/absolute",
        "",
        `${"x".repeat(200)}`,
      ]) {
        expect(cursorChildTranscriptPath(hostile)).toBeUndefined();
      }
    } finally {
      if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
    }
  });

  test("does not replace native ACP nested children with JSONL parts", async () => {
    const { syncCursorChildTranscriptParts } = await import("./acp-cursor-transcript-parts.js");
    const state = {
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [
          {
            type: "tool-invocation" as const,
            content: "Task",
            sourcePartId: "parent",
            sourceMessageId: "message-1",
            toolUseId: "cursor-subagent-1",
            toolName: "task",
            toolArgs: { agentId: "child-wait-1" },
            toolState: "success" as const,
            agentState: "active" as const,
          },
          {
            type: "tool-invocation" as const,
            content: "Search Find",
            sourcePartId: "native-child",
            sourceMessageId: "message-1",
            toolUseId: "cursor-child-grep-1",
            toolName: "Grep",
            parentTaskUseId: "cursor-subagent-1",
            toolState: "success" as const,
          },
        ],
      }],
      revision: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      status: "idle" as const,
    };

    const synced = syncCursorChildTranscriptParts(
      state as never,
      { toolUseId: "cursor-subagent-1", agentId: "child-wait-1" },
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "package.json" } }] },
      })}\n`,
      "ended",
    );

    expect(synced).toBe(false);
    expect(state.messages[0]?.parts.map((part) => part.sourcePartId)).toEqual([
      "parent",
      "native-child",
    ]);
  });

  test("keeps two children's projections separate in one owner message", async () => {
    const { syncCursorChildTranscriptParts } = await import("./acp-cursor-transcript-parts.js");
    const launch = (toolUseId: string, agentId: string) => ({
      type: "tool-invocation" as const,
      content: "Task",
      sourcePartId: toolUseId,
      sourceMessageId: "message-1",
      toolUseId,
      toolName: "task",
      toolArgs: { agentId },
      toolState: "success" as const,
      agentState: "active" as const,
    });
    const state = {
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [launch("cursor-subagent-1", "child-a"), launch("cursor-subagent-2", "child-b")],
      }],
      revision: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      status: "idle" as const,
    };
    const record = (name: string) => `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input: {} }] },
    })}\n`;

    expect(syncCursorChildTranscriptParts(
      state as never,
      { toolUseId: "cursor-subagent-1", agentId: "child-a" },
      record("ReadA"),
      "ended",
    )).toBe(true);
    expect(syncCursorChildTranscriptParts(
      state as never,
      { toolUseId: "cursor-subagent-2", agentId: "child-b" },
      record("ReadB"),
      "ended",
    )).toBe(true);

    // Each child lands directly under its own launch and neither sync clears
    // the other's parts.
    expect(state.messages[0]?.parts.map((part) => part.sourcePartId)).toEqual([
      "cursor-subagent-1",
      "cursor-jsonl:child-a:0:0",
      "cursor-subagent-2",
      "cursor-jsonl:child-b:0:0",
    ]);

    // Re-syncing one child must not disturb the other.
    expect(syncCursorChildTranscriptParts(
      state as never,
      { toolUseId: "cursor-subagent-1", agentId: "child-a" },
      record("ReadA") + record("ReadA2"),
      "ended",
    )).toBe(true);
    expect(state.messages[0]?.parts.map((part) => part.sourcePartId)).toEqual([
      "cursor-subagent-1",
      "cursor-jsonl:child-a:0:0",
      "cursor-jsonl:child-a:1:0",
      "cursor-subagent-2",
      "cursor-jsonl:child-b:0:0",
    ]);
  });

  describe("hydration selection and read caching", () => {
    const makeState = (launches: Array<{ toolUseId: string; agentId: string }>) => ({
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: launches.map((launch) => ({
          type: "tool-invocation" as const,
          content: "Task",
          sourcePartId: launch.toolUseId,
          sourceMessageId: "message-1",
          toolUseId: launch.toolUseId,
          toolName: "task",
          toolArgs: { agentId: launch.agentId },
          toolState: "success" as const,
        })),
      }],
      revision: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      status: "idle" as const,
      activeSubagentToolIds: new Set<string>(),
      activeSubagentDescriptors: new Map(),
      subagentToolIds: new Map(),
    });

    async function writeChild(root: string, agentId: string, body: string): Promise<string> {
      const childDir = resolve(root, agentId);
      await fs.mkdir(childDir, { recursive: true });
      const file = resolve(childDir, `${agentId}.jsonl`);
      await fs.writeFile(file, body);
      return file;
    }

    const toolRecord = (name: string) => `${JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", name, input: {} }] },
    })}\n`;

    // The launch parts are not in the active registry, so this exercises the
    // message-scan fallback rather than `listWatchableCursorChildren`.
    test("hydrates settled launches from the message scan, capped at the limit", async () => {
      const {
        hydrateCursorChildTranscripts,
        resetCursorTranscriptReadCache,
      } = await import("./acp-cursor-background.js");
      const { MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN } = await import("./acp-context.js");
      const root = resolve(await temporaryDirectory(), "transcripts");
      const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = root;
      resetCursorTranscriptReadCache();
      try {
        const total = MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN + 3;
        const launches = [];
        for (let index = 0; index < total; index += 1) {
          const agentId = `child-${index}`;
          await writeChild(root, agentId, toolRecord(`Tool${index}`));
          launches.push({ toolUseId: `cursor-subagent-${index}`, agentId });
        }
        const state = makeState(launches);

        hydrateCursorChildTranscripts(state as never);

        const hydratedAgentIds = (state.messages[0]?.parts ?? [])
          .map((part) => String(part.sourcePartId))
          .filter((sourcePartId) => sourcePartId.startsWith("cursor-jsonl:"))
          .map((sourcePartId) => sourcePartId.split(":")[1]);

        // Exactly the cap, and it is the scan order that decides which: the
        // first `MAX` launches encountered win and the rest are left bare.
        expect(hydratedAgentIds).toEqual(
          Array.from(
            { length: MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN },
            (_unused, index) => `child-${index}`,
          ),
        );
        for (let index = MAX_CURSOR_TRANSCRIPT_HYDRATE_CHILDREN; index < total; index += 1) {
          expect(hydratedAgentIds.includes(`child-${index}`)).toBe(false);
        }
      } finally {
        if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
        else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
      }
    });

    // A child that never wrote a terminal record and is no longer tracked is
    // abandoned, not finished: its last tool must not be shown as successful.
    test("projects an untracked child without a terminal record as abandoned", async () => {
      const {
        hydrateCursorChildTranscripts,
        resetCursorTranscriptReadCache,
      } = await import("./acp-cursor-background.js");
      const root = resolve(await temporaryDirectory(), "transcripts");
      const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = root;
      resetCursorTranscriptReadCache();
      try {
        await writeChild(root, "child-wait-1", toolRecord("Read"));
        const state = makeState([
          { toolUseId: "cursor-subagent-1", agentId: "child-wait-1" },
        ]);

        hydrateCursorChildTranscripts(state as never);

        expect(state.messages[0]?.parts.at(-1)).toMatchObject({
          toolName: "Read",
          toolState: "failure",
          toolError: "The sub-agent ended before this tool reported a result",
        });
      } finally {
        if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
        else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
      }
    });

    // The read cache is keyed on size+mtime, but a child leaving the active
    // registry changes the derived state without touching the file. A
    // file-only cache would strand the trailing tool as `pending` forever.
    test("re-syncs when the child leaves the registry without the file changing", async () => {
      const {
        hydrateCursorChildTranscripts,
        resetCursorTranscriptReadCache,
      } = await import("./acp-cursor-background.js");
      const root = resolve(await temporaryDirectory(), "transcripts");
      const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = root;
      resetCursorTranscriptReadCache();
      try {
        await writeChild(root, "child-wait-1", toolRecord("Read"));
        const state = makeState([
          { toolUseId: "cursor-subagent-1", agentId: "child-wait-1" },
        ]);
        state.activeSubagentToolIds.add("cursor-subagent-1");
        state.activeSubagentDescriptors.set(
          "cursor-subagent-1",
          { agentId: "child-wait-1", toolState: "success" } as never,
        );

        hydrateCursorChildTranscripts(state as never);
        expect(state.messages[0]?.parts.at(-1)).toMatchObject({ toolState: "pending" });

        const revisionAfterFirst = state.revision;
        // Nothing changed at all: the cached stat short-circuits the read.
        hydrateCursorChildTranscripts(state as never);
        expect(state.revision).toBe(revisionAfterFirst);
        expect(state.messages[0]?.parts.at(-1)).toMatchObject({ toolState: "pending" });

        // The child settles. The file is byte-identical, so only the derived
        // state can drive this re-sync.
        state.activeSubagentToolIds.delete("cursor-subagent-1");
        hydrateCursorChildTranscripts(state as never);
        expect(state.revision).toBeGreaterThan(revisionAfterFirst);
        expect(state.messages[0]?.parts.at(-1)).toMatchObject({
          toolState: "failure",
          toolError: "The sub-agent ended before this tool reported a result",
        });
      } finally {
        if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
        else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
      }
    });

    test("skips a child whose agentId is not a safe path segment", async () => {
      const {
        hydrateCursorChildTranscripts,
        resetCursorTranscriptReadCache,
      } = await import("./acp-cursor-background.js");
      const root = resolve(await temporaryDirectory(), "transcripts");
      const previous = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
      process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = root;
      resetCursorTranscriptReadCache();
      try {
        // A real file the traversal would reach if the id were not rejected.
        await writeChild(root, "escape", toolRecord("Secret"));
        const state = makeState([
          { toolUseId: "cursor-subagent-1", agentId: "../escape" },
        ]);

        hydrateCursorChildTranscripts(state as never);

        expect(state.revision).toBe(0);
        expect(state.messages[0]?.parts).toHaveLength(1);
      } finally {
        if (previous === undefined) delete process.env.CURSOR_AGENT_TRANSCRIPTS_DIR;
        else process.env.CURSOR_AGENT_TRANSCRIPTS_DIR = previous;
      }
    });
  });

  // Projections are not ACP tool calls. The reconciler settles abandoned tool
  // calls at turn end; doing that to a live child's projection would report a
  // running tool as failed and then flicker back on the next poll.
  test("reconciliation leaves a live child's projected parts pending", async () => {
    const { syncCursorChildTranscriptParts } = await import("./acp-cursor-transcript-parts.js");
    const { reconcileStaleToolParts } = await import("./acp-reconciliation.js");
    const state = {
      messages: [{
        id: "message-1",
        role: "assistant" as const,
        content: "",
        createdAt: "2026-01-01T00:00:00.000Z",
        parts: [{
          type: "tool-invocation" as const,
          content: "Task",
          sourcePartId: "parent",
          sourceMessageId: "message-1",
          toolUseId: "cursor-subagent-1",
          toolName: "task",
          toolArgs: { agentId: "child-wait-1" },
          toolState: "success" as const,
          agentState: "active" as const,
        }],
      }],
      revision: 0,
      droppedMessages: 0,
      droppedParts: 0,
      transcriptTruncated: false,
      outputTruncated: false,
      uncheckedTranscriptBytes: 0,
      status: "idle" as const,
      activeSubagentToolIds: new Set(["cursor-subagent-1"]),
      activeSubagentDescriptors: new Map([
        ["cursor-subagent-1", { agentId: "child-wait-1", toolState: "success" as const }],
      ]),
      subagentToolIds: new Map(),
    };

    syncCursorChildTranscriptParts(
      state as never,
      { toolUseId: "cursor-subagent-1", agentId: "child-wait-1" },
      `${JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "Read", input: { path: "a.ts" } }] },
      })}\n`,
      "live",
    );
    const projected = state.messages[0]?.parts.find((part) =>
      part.sourcePartId === "cursor-jsonl:child-wait-1:0:0"
    );
    expect(projected).toMatchObject({ toolState: "pending" });

    reconcileStaleToolParts(state as never);

    expect(projected).toMatchObject({ toolState: "pending" });
    expect(projected).not.toHaveProperty("toolError");
  });
});
