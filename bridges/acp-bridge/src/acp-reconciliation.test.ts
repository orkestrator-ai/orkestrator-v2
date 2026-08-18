import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  nativeFetch,
  spawnBridge,
  temporaryDirectory,
  waitFor,
  waitForExit,
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

  test("reconciles stale pending tool parts after a restart", async () => {
    const stateDirectory = await temporaryDirectory();
    await fs.writeFile(
      resolve(stateDirectory, "state.json"),
      JSON.stringify({
        version: 3,
        provider: "cursor",
        sessions: [
          {
            id: "session-idle-pending",
            clientSessionKey: "env-1:tab-pending",
            acpSessionId: "acp-session-pending",
            status: "idle",
            revision: 3,
            structured: [],
            promptJournal: [],
            messages: [
              {
                id: "message-1",
                role: "assistant",
                content: "",
                parts: [
                  {
                    type: "tool-invocation",
                    content: "Run tests",
                    sourcePartId: "tool:run-1",
                    sourceMessageId: "message-1",
                    toolUseId: "run-1",
                    toolName: "run",
                    toolState: "pending",
                  },
                  {
                    type: "tool-invocation",
                    content: "Edit file",
                    sourcePartId: "tool:edit-1",
                    sourceMessageId: "message-1",
                    toolUseId: "edit-1",
                    toolName: "edit",
                    toolState: "pending",
                    toolError: "already noted",
                  },
                  {
                    type: "tool-invocation",
                    content: "Search",
                    sourcePartId: "tool:search-1",
                    sourceMessageId: "message-1",
                    toolUseId: "search-1",
                    toolName: "search",
                    toolState: "success",
                  },
                ],
                createdAt: "2026-08-01T00:00:00.000Z",
              },
            ],
          },
          {
            id: "session-error-pending",
            clientSessionKey: "env-1:tab-error",
            acpSessionId: "acp-session-error",
            status: "error",
            revision: 1,
            structured: [],
            promptJournal: [],
            messages: [
              {
                id: "message-2",
                role: "assistant",
                content: "",
                parts: [
                  {
                    type: "tool-invocation",
                    content: "Write file",
                    sourcePartId: "tool:write-1",
                    sourceMessageId: "message-2",
                    toolUseId: "write-1",
                    toolName: "write",
                    toolState: "pending",
                  },
                ],
                createdAt: "2026-08-01T00:00:01.000Z",
              },
            ],
          },
        ],
      }),
    );

    const bridge = await spawnBridge({ stateDirectory });
    const idle = (await nativeFetch(`${bridge.base}/session/session-idle-pending`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(idle.messages[0]?.parts).toEqual([
      {
        type: "tool-invocation",
        content: "Run tests",
        sourcePartId: "tool:run-1",
        sourceMessageId: "message-1",
        toolUseId: "run-1",
        toolName: "run",
        toolState: "failure",
        toolError: "Tool call ended without a result",
      },
      {
        type: "tool-invocation",
        content: "Edit file",
        sourcePartId: "tool:edit-1",
        sourceMessageId: "message-1",
        toolUseId: "edit-1",
        toolName: "edit",
        toolState: "failure",
        toolError: "already noted",
      },
      {
        type: "tool-invocation",
        content: "Search",
        sourcePartId: "tool:search-1",
        sourceMessageId: "message-1",
        toolUseId: "search-1",
        toolName: "search",
        toolState: "success",
      },
    ]);

    const errored = (await nativeFetch(`${bridge.base}/session/session-error-pending`, {
      headers: bridge.headers,
    }).then((response) => response.json())) as {
      status: string;
      messages: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(errored.messages[0]?.parts[0]).toMatchObject({
      toolUseId: "write-1",
      toolState: "failure",
      toolError: "Tool call ended without a result",
    });
  });

  test("resumes a flattened resource-exhausted turn with exponential backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-prompts.log");
    const promptBlocksFile = resolve(directory, "resource-retry-blocks.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_PROMPT_BLOCKS_FILE: promptBlocksFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: finish without repeating completed work",
        requestId: "resource-retry-1",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{
            role: string;
            content: string;
            parts: Array<Record<string, unknown>>;
          }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain(
      "Recovered and finished the original request.",
    );
    expect(session.messages.at(-1)?.content).not.toContain("resource_exhausted");
    expect(
      session.messages.at(-1)?.parts.find((part) => part.toolUseId === "resource-safe-1"),
    ).toMatchObject({ toolState: "success" });
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);

    const promptBlocks = (await fs.readFile(promptBlocksFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<{ type?: string; text?: string }>);
    expect(promptBlocks[0]?.[0]?.text).toBe(
      "RESOURCEEXHAUSTED: finish without repeating completed work",
    );
    expect(
      promptBlocks
        .slice(1)
        .every((blocks) =>
          blocks[0]?.text?.startsWith("Continue from where the interrupted turn stopped."),
        ),
    ).toBe(true);
  });

  test("retries a structured ACP resource-exhausted response", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-rpc-retry-prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTEDRPC: retry the typed failure",
        requestId: "resource-rpc-retry-1",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toBe("Recovered from the structured RPC error.");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  test("fails visibly after three resource-exhausted retries", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-exhausted.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: keep failing",
        requestId: "resource-retry-2",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "error",
    );

    expect(session.error).toBe("cursor remained in a retriable provider error after 3 retries");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain(
      "Error: RetriableError: [resource_exhausted] Error",
    );
    // Initial dispatch plus exactly three retries.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  test("retries a flattened unavailable PING timeout with exponential backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "unavailable-retry-prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
        FAKE_ACP_RETRIABLE_CODE: "unavailable",
        FAKE_ACP_RETRIABLE_DETAIL: "PING timed out",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: finish after the ping timeout",
        requestId: "unavailable-retry-1",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain(
      "Recovered and finished the original request.",
    );
    expect(session.messages.at(-1)?.content).not.toContain("[unavailable]");
    expect(session.messages.at(-1)?.content).not.toContain("PING timed out");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  test("retries a structured ACP unavailable PING timeout", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "unavailable-rpc-retry-prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS: "2",
        FAKE_ACP_RETRIABLE_CODE: "unavailable",
        FAKE_ACP_RETRIABLE_DETAIL: "PING timed out",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTEDRPC: retry the ping timeout",
        requestId: "unavailable-rpc-retry-1",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toBe("Recovered from the structured RPC error.");
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(3);
  });

  test("preserves assistant text after an unavailable marker with no detail", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "unavailable-no-detail-prompts.log");
    const { base, headers } = await spawnBridge({
      env: {
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
        FAKE_ACP_RETRIABLE_CODE: "unavailable",
        FAKE_ACP_RETRIABLE_DETAIL: "\n\nActual successful response",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: preserve the successful response",
        requestId: "unavailable-no-detail-1",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    expect(session.error).toBeUndefined();
    expect(session.messages.at(-1)?.content).toContain(
      "Error: RetriableError: [unavailable] \n\nActual successful response",
    );
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("fails visibly after three unavailable retries", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "unavailable-retry-exhausted.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
        FAKE_ACP_RETRIABLE_CODE: "unavailable",
        FAKE_ACP_RETRIABLE_DETAIL: "PING timed out",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: keep failing the ping timeout",
        requestId: "unavailable-retry-2",
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "error",
    );

    expect(session.error).toBe("cursor remained in a retriable provider error after 3 retries");
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(session.messages.at(-1)?.content).toContain(
      "Error: RetriableError: [unavailable] PING timed out",
    );
    // Initial dispatch plus exactly three retries.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(4);
  });

  test("cancels a resource-exhausted turn while it is in backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-cancelled.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "500",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: cancel me",
        requestId: "resource-retry-3",
      }),
    });
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim().split("\n").filter(Boolean).length === 1,
    );
    const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(202);
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );
    await Bun.sleep(100);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("recovers a structured turn without replaying the interrupted attempt's output", async () => {
    const directory = await temporaryDirectory();
    const promptBlocksFile = resolve(directory, "structured-rpc-retry-blocks.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_PROMPT_BLOCKS_FILE: promptBlocksFile,
        FAKE_ACP_RPC_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
        // The interrupted attempt streams a JSON prefix. Carrying it into the
        // continuation would concatenate into a value that cannot parse.
        FAKE_ACP_RESOURCE_EXHAUSTED_PARTIAL: '{"answer":"par',
        FAKE_ACP_RESOURCE_EXHAUSTED_FINAL: '{"answer":"recovered"}',
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTEDRPC: produce the structured value",
        requestId: "structured-retry-1",
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();

    const structured = await waitFor(
      async () =>
        nativeFetch(
          `${base}/session/${created.id}/structured-output?requestId=structured-retry-1`,
          { headers },
        ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({
      ok: true,
      value: { answer: "recovered" },
    });

    // The continuation replaces the original prompt on the wire, so it has to
    // restate the contract the structured turn must still satisfy.
    const promptBlocks = (await fs.readFile(promptBlocksFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Array<{ type?: string; text?: string }>);
    expect(promptBlocks).toHaveLength(2);
    expect(promptBlocks[1]?.[0]?.text).toContain(
      "End your turn with exactly one JSON value matching this JSON Schema.",
    );
    expect(promptBlocks[1]?.[0]?.text).toContain('"answer"');
  });

  test("recovers a structured turn interrupted by a flattened resource-exhausted error", async () => {
    const directory = await temporaryDirectory();
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
        FAKE_ACP_RESOURCE_EXHAUSTED_PARTIAL: '{"answer":"par',
        FAKE_ACP_RESOURCE_EXHAUSTED_FINAL: '{"answer":"flattened-recovered"}',
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: produce the structured value",
        requestId: "structured-retry-2",
        outputSchema: { type: "object", properties: { answer: { type: "string" } } },
      }),
    });
    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.error).toBeUndefined();

    const structured = await waitFor(
      async () =>
        nativeFetch(
          `${base}/session/${created.id}/structured-output?requestId=structured-retry-2`,
          { headers },
        ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({
      ok: true,
      value: { answer: "flattened-recovered" },
    });
  });

  test("rejects a concurrent prompt while a resource-exhausted turn is in backoff", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-busy.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "800",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "1",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: stay busy",
        requestId: "resource-busy-1",
      }),
    });
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim().split("\n").filter(Boolean).length === 1,
    );

    // A turn parked in backoff still owns the session: it has not finished, and
    // a second dispatch would race the continuation onto the same thread.
    const busy = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "second turn", requestId: "resource-busy-2" }),
    });
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ error: "Session is already running" });

    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{
          status: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    expect(session.messages.at(-1)?.content).toContain(
      "Recovered and finished the original request.",
    );
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(2);
  });

  test("suppresses resource-exhausted retries for a turn cancelled while it was dispatching", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "resource-retry-cancel-dispatch.log");
    const { base, headers } = await spawnBridge({
      env: {
        ACP_RESOURCE_EXHAUSTED_RETRY_BASE_MS: "10",
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_FLATTENED_RESOURCE_EXHAUSTED_ATTEMPTS: "4",
        // Holds `session/load` open, so the respawn below keeps the prompt claim
        // in its dispatching window long enough to cancel inside it.
        FAKE_ACP_LOAD_DELAY_MS: "800",
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };

    // Kill the child so the next prompt has to respawn, which is what makes the
    // dispatching window wide instead of a single microtask.
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "CRASH now", requestId: "resource-dispatch-crash" }),
    });
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (value) => value.status === "error",
    );

    // Deliberately not awaited: the response only arrives once the turn has been
    // dispatched, and the cancel has to land before that.
    const dispatched = nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "RESOURCEEXHAUSTED: cancel during dispatch",
        requestId: "resource-dispatch-1",
      }),
    });
    await Bun.sleep(200);
    const cancelled = await nativeFetch(`${base}/session/${created.id}/cancel`, {
      method: "POST",
      headers,
    });
    expect(cancelled.status).toBe(202);
    expect((await dispatched).status).toBe(202);

    const session = await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(session.status).toBe("idle");
    await Bun.sleep(100);
    // One dispatch, no retries: the cancel that arrived before the turn took its
    // sequence still applies to it.
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("reattaches a detached session through session/load and reports a refusal", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "reattach-lifecycle.log");
    const bridge = await spawnBridge({ env: { FAKE_ACP_LIFECYCLE_FILE: lifecycleFile } });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };

    // Kill the agent underneath the bridge; the session must survive as state.
    const firstPid = Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]);
    process.kill(firstPid, "SIGKILL");
    await waitFor(
      async () =>
        nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then(
          (response) => response.json(),
        ) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    // The next prompt transparently spawns a replacement and resumes the thread.
    const resumed = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:back online", requestId: "reattach-1" }),
    });
    expect(resumed.status).toBe(202);
    const session = await waitFor(
      async () =>
        nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers }).then(
          (response) => response.json(),
        ) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toEqual([
      "DIRECT:back online",
      "back online",
    ]);
    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    expect(lifecycle.match(/^start:/gm)).toHaveLength(2);
    expect(lifecycle).toContain("load:");
  });

  test("refuses to reattach when the agent cannot reload sessions", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "no-load-lifecycle.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_NO_LOAD_SESSION: "1",
      },
    });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () =>
        nativeFetch(`${bridge.base}/session/${created.id}/status`, {
          headers: bridge.headers,
        }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    // Reattaching would silently start a *different* conversation, so the
    // bridge must refuse rather than resume against an agent with no rollout.
    const refused = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:hello", requestId: "no-load-1" }),
    });
    expect(refused.status).toBe(410);
    expect(await refused.json()).toMatchObject({
      error: "cursor cannot reload persisted ACP sessions",
    });
    expect(await fs.readFile(lifecycleFile, "utf8")).not.toContain("load:");
    // The refusal released the claim, so the same requestId is not journaled
    // as an already-dispatched duplicate.
    const retried = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:hello", requestId: "no-load-1" }),
    });
    expect(retried.status).toBe(410);
  });

  test("rejects a failed reattach and lets the same requestId be retried", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "failed-load-lifecycle.log");
    const bridge = await spawnBridge({
      env: {
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
        FAKE_ACP_FAIL_LOAD_SESSION: "1",
        FAKE_ACP_FAIL_LOAD_DELAY_MS: "800",
      },
    });
    const created = (await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json())) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () =>
        nativeFetch(`${bridge.base}/session/${created.id}/status`, {
          headers: bridge.headers,
        }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const send = () =>
      nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
        method: "POST",
        headers: bridge.headers,
        body: JSON.stringify({ prompt: "DIRECT:retry", requestId: "retry-me" }),
      });
    const firstPending = send();
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^load:/gm)?.length ?? 0) === 1,
    );
    expect(
      await nativeFetch(`${bridge.base}/session/${created.id}/dispatch?requestId=retry-me`, {
        headers: bridge.headers,
      }).then((response) => response.json()),
    ).toEqual({ dispatch: "unknown" });
    const first = await firstPending;
    expect(first.status).toBe(500);
    expect(await first.json()).toMatchObject({ error: "fake agent cannot load that session" });
    expect(
      await nativeFetch(`${bridge.base}/session/${created.id}/dispatch?requestId=retry-me`, {
        headers: bridge.headers,
      }).then((response) => response.json()),
    ).toEqual({ dispatch: "unknown" });
    // The turn provably never ran, so the claim must be released rather than
    // leaving the requestId permanently journaled as a duplicate.
    const second = await send();
    expect(second.status).toBe(500);
    expect((await nativeFetch(`${bridge.base}/global/health`)).ok).toBe(true);
  });

  test("refuses to redispatch a prompt whose outcome a crash left unknown", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = (await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json())) as { id: string };

    const dispatch = await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "Do the work", requestId: "request-1" }),
    });
    expect(dispatch.status).toBe(202);
    // The fake agent parks a permission, so the turn is still in flight and the
    // journal is still "accepted" when the bridge dies — it restores as
    // "ambiguous" on the next process.
    await waitFor(
      async () =>
        nativeFetch(`${first.base}/session/${created.id}/approvals`, {
          headers: first.headers,
        }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );

    first.child.kill("SIGKILL");
    await waitForExit(first.child);

    const second = await spawnBridge({ stateDirectory });
    const redelivery = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "Do the work", requestId: "request-1" }),
    });
    expect(redelivery.status).toBe(410);
    expect(await redelivery.json()).toMatchObject({
      error:
        "cursor prompt outcome is unknown after a bridge restart; resubmit with a new requestId",
    });

    // The at-most-once work was never re-executed and a fresh requestId still
    // recovers the session through session/load.
    const recovered = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "DIRECT:recovered", requestId: "request-2" }),
    });
    expect(recovered.status).toBe(202);
    const session = await waitFor(
      async () =>
        nativeFetch(`${second.base}/session/${created.id}`, { headers: second.headers }).then(
          (response) => response.json(),
        ) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toContain("recovered");
  });

  test("dispatches a prompt at most once when concurrent requests race a reattach", async () => {
    // Reattaching spawns a process and performs two round trips, so it is the
    // window where a second request can slip between the duplicate check and
    // the claim. The turn must still reach the agent exactly once, and only
    // one replacement child may be started.
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "concurrent-prompts.log");
    const lifecycleFile = resolve(directory, "concurrent-lifecycle.log");
    const { base, headers } = await spawnBridge({
      env: {
        FAKE_ACP_COUNTER_FILE: counterFile,
        FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      },
    });
    const created = (await nativeFetch(`${base}/session/create`, { method: "POST", headers }).then(
      (response) => response.json(),
    )) as { id: string };
    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}/status`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (session) => session.status === "error",
    );

    const send = () =>
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "DIRECT:only once", requestId: "concurrent-1" }),
      });
    const responses = await Promise.all([send(), send(), send(), send()]);
    expect(
      responses.map((response) => response.status).filter((status) => status === 202).length,
    ).toBeGreaterThan(0);
    expect(responses.every((response) => response.status === 202 || response.status === 409)).toBe(
      true,
    );
    await waitFor(
      async () =>
        nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) =>
          response.json(),
        ) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
    // One original agent plus exactly one replacement.
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^start:/gm)).toHaveLength(2);
  });
});
