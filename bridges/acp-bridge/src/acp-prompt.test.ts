import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

// Must precede every bridge import below: `acp-prompt.js` pulls in
// `acp-context.js`, which resolves `ACP_PROVIDER` at module scope and throws
// without it. Keep this first.
import "./testing/unit-test-env.js";
import {
  ONE_PIXEL_PNG,
  nativeFetch,
  spawnBridge,
  stopChild,
  temporaryDirectory,
  waitFor,
} from "./acp-test-harness.js";
import {
  FLATTENED_RETRIABLE_PROVIDER_SUFFIX,
  RETRIABLE_PROVIDER_ERROR,
  retriableProviderError,
} from "./acp-prompt.js";


describe("ACP bridge", () => {



  test("classifies resource_exhausted and unavailable provider errors as retriable", () => {
    expect(RETRIABLE_PROVIDER_ERROR.test("RetriableError: [resource_exhausted] Error")).toBe(true);
    expect(RETRIABLE_PROVIDER_ERROR.test("RetriableError: [unavailable] PING timed out")).toBe(true);
    expect(RETRIABLE_PROVIDER_ERROR.test("GoogleGenerativeAIFetchError: [unavailable] PING timed out"))
      .toBe(true);
    expect(RETRIABLE_PROVIDER_ERROR.test("permission denied: [invalid_argument] Error")).toBe(false);
    expect(retriableProviderError(new Error("RetriableError: [unavailable] PING timed out"))).toBe(true);
    expect(retriableProviderError(new Error("cursor ACP session/prompt timed out"))).toBe(false);

    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Completed the first safe step.\n\nError: RetriableError: [unavailable] PING timed out",
    )).toBe(true);
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Error: GoogleGenerativeAIFetchError: [resource_exhausted] Error",
    )).toBe(true);
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Error: RetriableError: [invalid_argument] Error",
    )).toBe(false);
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Error: RetriableError: [unavailable] PING timed out\n\nMore assistant text",
    )).toBe(false);
  });



  // Both classifiers recognise the same provider failure arriving over two
  // transports: a typed `session/prompt` rejection and Cursor's flattening bug.
  // A separator only one of them accepts would retry the RPC form while
  // reporting the flattened form as a finished turn, leaving the raw provider
  // serialization in the transcript. They must agree character for character.
  test("both retriable-provider classifiers accept the same code separators", () => {
    // `\n` included: a provider that wraps the detail onto its own line is the
    // same failure, and the flattened detail stays bounded to one line either
    // way, so accepting it costs no extra transcript.
    for (const separator of [" ", "  ", "\t", " \t ", "\n", "\r\n", " \n\t"]) {
      const detail = `RetriableError: [unavailable]${separator}PING timed out`;
      expect(RETRIABLE_PROVIDER_ERROR.test(detail)).toBe(true);
      expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(`Answer.\n\nError: ${detail}`)).toBe(true);
    }
    // An empty or whitespace-only detail is retriable to neither: there is
    // nothing after the code to distinguish a real failure from prose that
    // merely names one. Two-or-more spaces used to disagree — flattened's
    // `[^\n]+` treated them as a detail while RPC's `\S` did not.
    for (const blank of ["", " ", "  ", "   ", "\t", " \t ", "\n", "\n  "]) {
      const detail = `RetriableError: [unavailable]${blank}`;
      expect(RETRIABLE_PROVIDER_ERROR.test(detail)).toBe(false);
      expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(`Answer.\n\nError: ${detail}`)).toBe(false);
    }
  });



  test("does not consume a later assistant paragraph as provider-error detail", () => {
    const answer =
      "Answer.\n\nError: RetriableError: [unavailable]\n\nActual successful response";

    expect(RETRIABLE_PROVIDER_ERROR.test(answer)).toBe(false);
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(answer)).toBe(false);
    expect(answer.replace(FLATTENED_RETRIABLE_PROVIDER_SUFFIX, "")).toBe(answer);
  });



  // The flattened detail is deliberately bounded to the final line. A provider
  // error that carries its own stack trace is left in the transcript and the
  // turn ends, rather than being stripped and retried: assistant text is
  // model-controlled, so a pattern that swallowed trailing lines could delete a
  // real answer. This pins that trade-off so widening it stays a conscious act.
  test("leaves a multi-line provider error detail unmatched rather than over-stripping", () => {
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Answer.\n\nError: RetriableError: [unavailable] PING timed out\n    at Socket.onTimeout",
    )).toBe(false);
    // The first line alone still matches, so a provider that drops the trace is
    // unaffected by the bound.
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Answer.\n\nError: RetriableError: [unavailable] PING timed out",
    )).toBe(true);
  });



  // The false-positive direction of the broadened detail matcher. An assistant
  // answer that quotes a provider error must survive: stripping it would delete
  // real work and silently re-run a turn that already succeeded.
  test("preserves an assistant answer that quotes a provider error", () => {
    // Fenced, which is how an agent reporting a log actually renders it.
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "The upstream call fails with:\n\n```\nError: RetriableError: [unavailable] PING timed out\n```",
    )).toBe(false);
    // Indented, quoted, or mid-paragraph citations are equally not tail errors.
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Root cause:\n\n> Error: RetriableError: [unavailable] PING timed out",
    )).toBe(false);
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "It logged `Error: RetriableError: [unavailable] PING timed out` on every retry.",
    )).toBe(false);
    // A single newline is not the `\n\n` boundary the flattened chunk arrives
    // with, so a wrapped sentence ending in the same words is left alone too.
    expect(FLATTENED_RETRIABLE_PROVIDER_SUFFIX.test(
      "Summary:\nError: RetriableError: [unavailable] PING timed out",
    )).toBe(false);
  });



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



  test("starts local-default Cursor ACP without project MCP auto-approval", async () => {
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "0" }))
      .toEqual(["--force", "acp"]);
  });



  test("treats a non-canonical Cursor MCP approval value as disabled", async () => {
    // The backend only ever writes "0" or "1". Anything else arrived from an
    // ambient environment the bridge did not choose, so it must not grant
    // repository-controlled MCP servers a host process.
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "true" }))
      .toEqual(["--force", "acp"]);
  });



  test("starts explicitly isolated Cursor ACP with MCP auto-approval", async () => {
    expect(await readAgentArgs({ ACP_APPROVE_PROJECT_MCPS: "1" }))
      .toEqual(["--force", "--approve-mcps", "acp"]);
  });



  test("ignores an agent's live echo of the user prompt", async () => {
    const bridge = await spawnBridge({ env: { FAKE_ACP_ECHO_USER_PROMPT: "1" } });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:Answered" }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          messages: Array<{ role: string; content: string }>;
        }>,
      (value) => value.status === "idle",
    );

    // The bridge already pushed the authoritative user message, so the echo
    // must neither append a second bubble nor double the prompt text inside
    // the first one.
    expect(session.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "DIRECT:Answered"],
      ["assistant", "Answered"],
    ]);
  });



  test("drives an ACP session and rehydrates a parked permission", async () => {
    const { base, headers } = await spawnBridge();

    const unauthorized = await nativeFetch(`${base}/session/create`, { method: "POST" });
    expect(unauthorized.status).toBe(401);
    const createdResponse = await nativeFetch(`${base}/session/create`, { method: "POST", headers });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { id: string };

    const promptResponse = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Do the work" }),
    });
    expect(promptResponse.status).toBe(202);
    const approval = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: Array<{ id: string; approvalId: string; title: string; kind: string }> }>,
      (value) => value.approvals.length === 1,
    );
    expect(approval.approvals[0]?.title).toBe("Run safe command");
    expect(approval.approvals[0]).toMatchObject({
      approvalId: approval.approvals[0]!.id,
      kind: "permissions",
    });

    const resolveResponse = await nativeFetch(
      `${base}/session/${created.id}/approvals/${approval.approvals[0]!.id}`,
      { method: "POST", headers, body: JSON.stringify({ decision: "approve" }) },
    );
    expect(resolveResponse.ok).toBe(true);
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string; parts: unknown[] }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.map((message) => message.content)).toEqual(["Do the work", "approved:once"]);
    expect(session.messages[1]?.parts).toEqual([
      {
        type: "thinking",
        content: "Checking permission. ",
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
        createdAt: expect.any(String),
      },
      {
        type: "tool-invocation",
        content: "Run safe command",
        sourcePartId: "tool:tool-1",
        sourceMessageId: expect.any(String),
        toolUseId: "tool-1",
        toolName: "execute",
        toolArgs: { command: "printf ok" },
        toolState: "success",
        toolTitle: "Run safe command",
        toolOutput: JSON.stringify({ exitCode: 0, stdout: "ok" }, null, 2),
        createdAt: expect.any(String),
      },
      {
        type: "text",
        content: "approved:once",
        sourcePartId: expect.any(String),
        sourceMessageId: expect.any(String),
        createdAt: expect.any(String),
      },
    ]);
  });



  test("reads ACP usage_update occupancy and PromptResponse.usage without Grok _meta", async () => {
    const stateDirectory = await temporaryDirectory();
    const first = await spawnBridge({ stateDirectory });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-usage-acp:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    type UsageSnapshot = {
      status: string;
      contextUsage?: Record<string, unknown>;
    };
    const readSession = async (base: string, headers: Record<string, string>) =>
      await nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as UsageSnapshot;

    expect((await nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "USAGE_ACP: report occupancy over ACP" }),
    })).status).toBe(202);

    const session = await waitFor(
      () => readSession(first.base, first.headers),
      (value) => value.status === "idle" && value.contextUsage !== undefined,
    );
    expect(session.contextUsage).toMatchObject({
      usedTokens: 15_675,
      maximumTokens: 200_000,
      inputTokens: 10_000,
      outputTokens: 2_000,
      reasoningTokens: 300,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 45,
      costUsd: 0.042,
      source: "provider",
    });
    expect(session.contextUsage?.percentage).toBeCloseTo(7.8375);

    first.child.kill("SIGTERM");
    await Bun.sleep(200);
    const second = await spawnBridge({ stateDirectory });
    const restored = await readSession(second.base, second.headers);
    expect(restored.contextUsage).toMatchObject({
      usedTokens: 15_675,
      maximumTokens: 200_000,
      inputTokens: 10_000,
      outputTokens: 2_000,
      reasoningTokens: 300,
      cacheReadTokens: 5_000,
      cacheWriteTokens: 45,
      costUsd: 0.042,
      source: "provider",
    });
    expect(restored.contextUsage?.percentage).toBeCloseTo(7.8375);
  });



  test("reads ACP v2 idle state_update.usage without PromptResponse.usage", async () => {
    const bridge = await spawnBridge({ stateDirectory: await temporaryDirectory() });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-usage-state:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    const readSession = async () =>
      await nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as {
          status: string;
          contextUsage?: Record<string, unknown>;
        };

    expect((await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "USAGE_STATE: complete over idle usage" }),
    })).status).toBe(202);

    const session = await waitFor(
      readSession,
      (value) => value.status === "idle" && value.contextUsage !== undefined,
    );
    expect(session.contextUsage).toMatchObject({
      usedTokens: 8_000,
      inputTokens: 7_000,
      outputTokens: 1_000,
      reasoningTokens: 50,
      cacheReadTokens: 4_000,
      // Only the mid-turn `running` frame reported the cache write. The idle
      // frame that closes the turn omits it, so this value proves the two
      // reports merged instead of the later one replacing the earlier.
      cacheWriteTokens: 20,
      source: "provider",
    });
    expect(session.contextUsage).not.toHaveProperty("maximumTokens");
    expect(session.contextUsage).not.toHaveProperty("percentage");
    expect(session.contextUsage).not.toHaveProperty("costUsd");
  });



  test("leaves a structured turn dispatched during a Cursor replay intact", async () => {
    const bridge = await spawnBridge({
      env: {
        ACP_MAX_TRANSCRIPT_BYTES: String(1024 * 1024),
        FAKE_ACP_LOAD_DELAY_MS: "600",
        FAKE_ACP_REPLAY_CURSOR_OVERSIZED_METADATA: "1",
      },
    });
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ clientSessionKey: "env-cursor-structured:tab-1" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "CURSOR_OVERSIZED_REPLAY" }),
    });
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (value) => value.status === "idle",
    );

    // Enrichment re-bounds the transcript, and a trim there must never be read
    // as *this* turn overflowing: a structured turn that failed would cancel
    // the live child and hand the caller an error for someone else's growth.
    const structuredResponse = await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({
        prompt: "DIRECT:{\"ok\":true}",
        requestId: "cursor-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    expect(structuredResponse.status).toBe(202);

    const settled = await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string; error?: string }>,
      (value) => value.status === "idle" || value.status === "error",
    );
    expect(settled.status).toBe("idle");
    expect(settled.error).toBeUndefined();

    const structured = await waitFor(
      async () => nativeFetch(
        `${bridge.base}/session/${created.id}/structured-output?requestId=cursor-structured-1`,
        { headers: bridge.headers },
      ).then((response) => response.json()) as Promise<{ structuredOutput: unknown }>,
      (value) => value.structuredOutput !== null,
    );
    expect(structured.structuredOutput).toMatchObject({ ok: true, value: { ok: true } });
  });



  test("fails a structured turn when its parts exhaust the per-message limit", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, {
      method: "POST",
      headers,
      body: JSON.stringify({ clientSessionKey: "env-tools:tab-many-structured" }),
    }).then((response) => response.json()) as { id: string };

    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "MANYTOOLS: flood the turn",
        requestId: "many-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{
          status: string;
          error?: string;
          messages: Array<{ parts: Array<Record<string, unknown>> }>;
        }>,
      (value) => value.status === "error",
    );

    // A structured turn is worth exactly its complete output, so trimming it
    // has to fail rather than hand back a partial answer as a whole one.
    expect(session.error).toContain("exceeded the transcript limit");
    expect(session.messages[1]?.parts).toHaveLength(512);
    expect(session.messages[1]?.parts.every((part) => part.type === "tool-invocation")).toBe(true);
  });



  test("deduplicates session creation and prompt dispatch by durable keys", async () => {
    const stateDirectory = await temporaryDirectory();
    const counterFile = resolve(stateDirectory, "prompts.log");
    const first = await spawnBridge({ stateDirectory, env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const create = () => nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as Promise<{ id: string }>;
    const [created, duplicateCreation] = await Promise.all([create(), create()]);
    expect(duplicateCreation.id).toBe(created.id);

    const send = () => nativeFetch(`${first.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ prompt: "DIRECT:once", requestId: "request-1" }),
    });
    expect((await send()).status).toBe(202);
    await waitFor(
      async () => nativeFetch(`${first.base}/session/${created.id}`, { headers: first.headers }).then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await send()).status).toBe(202);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);

    await stopChild(first.child);
    const second = await spawnBridge({ stateDirectory, env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const restored = await nativeFetch(`${second.base}/session/create`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    expect(restored.id).toBe(created.id);
    const duplicateAfterRestart = await nativeFetch(`${second.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ prompt: "DIRECT:once", requestId: "request-1" }),
    });
    expect(duplicateAfterRestart.status).toBe(202);
    expect((await fs.readFile(counterFile, "utf8")).trim().split("\n")).toEqual(["prompt"]);
  });



  test("answers whether a request id was ever dispatched", async () => {
    const bridge = await spawnBridge();
    const created = await nativeFetch(`${bridge.base}/session/create`, {
      method: "POST",
      headers: bridge.headers,
    }).then((response) => response.json()) as { id: string };
    const dispatchStatus = (requestId: string) => nativeFetch(
      `${bridge.base}/session/${created.id}/dispatch?requestId=${encodeURIComponent(requestId)}`,
      { headers: bridge.headers },
    ).then((response) => response.json()) as Promise<{ dispatch: string }>;

    expect(await dispatchStatus("never-sent")).toEqual({ dispatch: "unknown" });
    // A blank id is a caller bug, not a claim about any turn.
    expect(await nativeFetch(
      `${bridge.base}/session/${created.id}/dispatch`,
      { headers: bridge.headers },
    ).then((response) => response.json())).toEqual({ dispatch: "unknown" });

    expect((await nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:done", requestId: "sent-1" }),
    })).status).toBe(202);
    // True while the turn runs and after it finishes: both mean the bridge took
    // the prompt, which is the whole question.
    expect(await dispatchStatus("sent-1")).toEqual({ dispatch: "dispatched" });
    await waitFor(
      async () => nativeFetch(`${bridge.base}/session/${created.id}`, { headers: bridge.headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect(await dispatchStatus("sent-1")).toEqual({ dispatch: "dispatched" });
  });



  test("attaches the agent process without dispatching a turn", async () => {
    const directory = await temporaryDirectory();
    const stateDirectory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "attach-lifecycle.log");
    const counterFile = resolve(directory, "attach-prompts.log");
    const env = {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_COUNTER_FILE: counterFile,
    };
    const first = await spawnBridge({ stateDirectory, env });
    const created = await nativeFetch(`${first.base}/session/create`, {
      method: "POST",
      headers: first.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    }).then((response) => response.json()) as { id: string };
    await stopChild(first.child);

    // A restored session has no child, which is exactly the cold start that
    // used to run inside the prompt request's at-most-once window.
    const second = await spawnBridge({ stateDirectory, env });
    await nativeFetch(`${second.base}/session/create`, {
      method: "POST",
      headers: second.headers,
      body: JSON.stringify({ clientSessionKey: "env-1:tab-1" }),
    });
    const attach = () => nativeFetch(`${second.base}/session/${created.id}/attach`, {
      method: "POST",
      headers: second.headers,
      body: "{}",
    });
    // Concurrent attaches share one spawn; without that they would each start
    // an agent and orphan the loser's process.
    const [a, b] = await Promise.all([attach(), attach()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await a.json()).toEqual({ attached: true });

    const lifecycle = await fs.readFile(lifecycleFile, "utf8");
    expect(lifecycle.match(/^load:/gm)?.length ?? 0).toBe(1);
    // Attaching is not dispatching: no turn may have been handed to the agent.
    expect(await fs.readFile(counterFile, "utf8").catch(() => "")).toBe("");
    await expect(nativeFetch(`${second.base}/session/${created.id}`, {
      headers: second.headers,
    }).then((response) => response.json())).resolves.toMatchObject({
      status: "idle",
    });
  });



  test("keeps later attaches and prompts behind an in-flight session load", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "attach-load-barrier-lifecycle.log");
    const counterFile = resolve(directory, "attach-load-barrier-prompts.log");
    const bridge = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
      FAKE_ACP_COUNTER_FILE: counterFile,
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

    const firstAttach = nativeFetch(`${bridge.base}/session/${created.id}/attach`, {
      method: "POST",
      headers: bridge.headers,
      body: "{}",
    });
    // The fake only records `load:` after the replacement child has been
    // assigned. Requests started after this point exercise the dangerous
    // child-present/load-incomplete interval, not merely concurrent spawning.
    await waitFor(
      () => fs.readFile(lifecycleFile, "utf8").catch(() => ""),
      (contents) => (contents.match(/^load:/gm)?.length ?? 0) === 1,
    );
    const secondAttach = nativeFetch(`${bridge.base}/session/${created.id}/attach`, {
      method: "POST",
      headers: bridge.headers,
      body: "{}",
    });
    const prompt = nativeFetch(`${bridge.base}/session/${created.id}/prompt`, {
      method: "POST",
      headers: bridge.headers,
      body: JSON.stringify({ prompt: "DIRECT:after load", requestId: "after-load-1" }),
    });
    const settlesWithin = (pending: Promise<Response>, milliseconds: number) => Promise.race([
      pending.then(() => true, () => true),
      Bun.sleep(milliseconds).then(() => false),
    ]);
    expect(await settlesWithin(secondAttach, 150)).toBe(false);
    expect(await settlesWithin(prompt, 150)).toBe(false);
    expect(await fs.readFile(counterFile, "utf8").catch(() => "")).toBe("");

    expect((await firstAttach).status).toBe(200);
    expect((await secondAttach).status).toBe(200);
    expect((await prompt).status).toBe(202);
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim() === "prompt",
    );
    expect((await fs.readFile(lifecycleFile, "utf8")).match(/^load:/gm)).toHaveLength(1);
  });



  test("rejects a second composer patch that races one already applying", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "config-race-lifecycle.log");
    const { base, headers } = await spawnBridge({ env: {
      FAKE_ACP_LIFECYCLE_FILE: lifecycleFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    // `applyComposerPatch` yields on every RPC. Without a claim taken before
    // the first await, both patches plan against the same stale sessionConfig
    // and the loser silently overwrites the winner's result.
    const patch = (modelId: string) => nativeFetch(`${base}/session/${created.id}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ modelId }),
    });
    const [first, second] = await Promise.all([patch("gpt-5.5"), patch("composer-2.5")]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = first.status === 200 ? "gpt-5.5" : "composer-2.5";
    const config = await nativeFetch(`${base}/session/${created.id}/config`, { headers })
      .then((response) => response.json()) as { selectedModelId?: string };
    expect(config.selectedModelId).toBe(winner);
  });



  test("rejects a prompt that races an in-flight composer patch", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    const [config, prompt] = await Promise.all([
      nativeFetch(`${base}/session/${created.id}/config`, {
        method: "POST",
        headers,
        body: JSON.stringify({ modelId: "gpt-5.5" }),
      }),
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "hello", requestId: "race-1" }),
      }),
    ]);
    // Whichever request the server reads first claims the session; the point is
    // that they can never both proceed, because a composer patch and a turn
    // would otherwise interleave their RPCs on one agent.
    expect([config.status, prompt.status].filter((status) => status === 409)).toHaveLength(1);
    if (prompt.status === 409) {
      // The refused turn was never journaled, so the same requestId can retry.
      const retried = await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "hello", requestId: "race-1" }),
      });
      expect(retried.status).toBe(202);
    }
  });



  test("fails an oversized structured turn rather than parsing a cut answer", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "OVERSIZED",
        requestId: "oversized-structured-1",
        outputSchema: { type: "object" },
      }),
    });
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; error?: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "error",
    );
    expect(session.error).toContain("transcript limit");
    expect(Buffer.byteLength(JSON.stringify(session.messages))).toBeLessThan(8 * 1024 * 1024);
  });



  test("uses only the current turn when parsing structured output", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const prompt = async (text: string, requestId: string) => {
      await nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          prompt: `DIRECT:${text}`,
          requestId,
          outputSchema: { type: "object" },
        }),
      });
      await waitFor(
        async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string }>,
        (session) => session.status === "idle",
      );
    };
    await prompt('{"turn":1}', "turn-1");
    await prompt("not-json", "turn-2");
    const result = await nativeFetch(
      `${base}/session/${created.id}/structured-output?requestId=turn-2`,
      { headers },
    ).then((response) => response.json()) as { structuredOutput: { ok: boolean; error?: { code?: string } } };
    expect(result.structuredOutput).toMatchObject({ ok: false, error: { code: "malformed_output" } });
  });



  test("denies pending permission when cancelled", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "cancel-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );
    await nativeFetch(`${base}/session/${created.id}/cancel`, { method: "POST", headers });
    const approvals = await nativeFetch(`${base}/session/${created.id}/approvals`, { headers })
      .then((response) => response.json()) as { approvals: unknown[] };
    expect(approvals.approvals).toEqual([]);
  });



  test("rejects a concurrent second turn that carries a different requestId", async () => {
    const directory = await temporaryDirectory();
    const counterFile = resolve(directory, "distinct-prompts.log");
    const { base, headers } = await spawnBridge({ env: { FAKE_ACP_COUNTER_FILE: counterFile } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    // The first prompt parks on a permission, so the turn is still running.
    const [first, second] = await Promise.all([
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "needs permission", requestId: "turn-a" }),
      }),
      nativeFetch(`${base}/session/${created.id}/prompt`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt: "needs permission too", requestId: "turn-b" }),
      }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([202, 409]);
    await waitFor(
      () => fs.readFile(counterFile, "utf8").catch(() => ""),
      (contents) => contents.trim() === "prompt",
    );
  });



  test("keeps live approvals when a superseded agent process exits", async () => {
    const { base, headers } = await spawnBridge();
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "approval-live-1" }),
    });
    const parked = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: Array<{ id: string; expiresAt: number; requestedAt: number }> }>,
      (value) => value.approvals.length === 1,
    );
    const approval = parked.approvals[0]!;
    // Approvals carry a bounded lifetime; nothing may park indefinitely.
    expect(approval.expiresAt - approval.requestedAt).toBe(5 * 60_000);

    // The approval belongs to the attached child and must outlive unrelated
    // churn, staying answerable rather than being silently dropped.
    await Bun.sleep(100);
    const stillParked = await nativeFetch(`${base}/session/${created.id}/approvals`, { headers })
      .then((response) => response.json()) as { approvals: unknown[] };
    expect(stillParked.approvals).toHaveLength(1);
    const resolved = await nativeFetch(
      `${base}/session/${created.id}/approvals/${approval.id}`,
      { method: "POST", headers, body: JSON.stringify({ decision: "deny" }) },
    );
    expect(resolved.ok).toBe(true);
    const session = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}`, { headers }).then((response) => response.json()) as Promise<{ status: string; messages: Array<{ content: string }> }>,
      (value) => value.status === "idle",
    );
    expect(session.messages.at(-1)?.content).toBe("approved:deny");
  });



  test("drops approvals when the agent that parked them dies", async () => {
    const directory = await temporaryDirectory();
    const lifecycleFile = resolve(directory, "approval-death.log");
    const { base, headers } = await spawnBridge({ env: { FAKE_ACP_LIFECYCLE_FILE: lifecycleFile } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "needs permission", requestId: "approval-death-1" }),
    });
    await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 1,
    );

    process.kill(
      Number(/^start:(\d+)$/m.exec(await fs.readFile(lifecycleFile, "utf8"))?.[1]),
      "SIGKILL",
    );
    const cleared = await waitFor(
      async () => nativeFetch(`${base}/session/${created.id}/approvals`, { headers }).then((response) => response.json()) as Promise<{ approvals: unknown[] }>,
      (value) => value.approvals.length === 0,
    );
    expect(cleared.approvals).toEqual([]);
    const status = await nativeFetch(`${base}/session/${created.id}/status`, { headers })
      .then((response) => response.json()) as { status: string };
    expect(status.status).toBe("error");
  });



  test("dispatches an image-only prompt and indexes every attachment part", async () => {
    const workspace = await temporaryDirectory();
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    await fs.writeFile(resolve(workspace, "first.png"), ONE_PIXEL_PNG);
    await fs.writeFile(resolve(workspace, "second.png"), ONE_PIXEL_PNG);
    const { base, headers } = await spawnBridge({ env: {
      CWD: workspace,
      FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };

    const dispatched = await nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        // Attaching a picture with no message at all is a normal send, so an
        // empty prompt with attachments must not be refused as an empty turn.
        prompt: "",
        requestId: "image-only-1",
        attachments: [
          { type: "image", path: "first.png", filename: "first.png" },
          { type: "image", path: "second.png", filename: "second.png" },
        ],
      }),
    });
    expect(dispatched.status).toBe(202);
    await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );

    const blocks = JSON.parse((await fs.readFile(blocksFile, "utf8")).trim()) as Array<{
      type: string;
    }>;
    // No empty text block: an agent handed `{ type: "text", text: "" }` can read
    // it as an instruction, and both agents accept an image-only prompt.
    expect(blocks.map((block) => block.type)).toEqual(["image", "image"]);

    const user = await nativeFetch(`${base}/session/${created.id}`, { headers })
      .then((response) => response.json())
      .then((session) => (session as {
        messages: Array<{ role: string; content: string; parts: Array<Record<string, unknown>> }>;
      }).messages.find((message) => message.role === "user"));
    expect(user?.content).toBe("");
    expect(user?.parts.map((part) => part.type)).toEqual(["file", "file"]);
    expect(user?.parts.map((part) => part.content)).toEqual(["first.png", "second.png"]);
    // Part ids stay one-based across the attachments so the second image cannot
    // reuse the id the text part would have taken.
    const messageId = user?.parts[0]?.sourceMessageId;
    expect(typeof messageId).toBe("string");
    expect(user?.parts.map((part) => part.sourcePartId))
      .toEqual([`${messageId}:1`, `${messageId}:2`]);
  });



  test("refuses attachments the bridge cannot safely read and leaves the turn dispatchable", async () => {
    const workspace = await temporaryDirectory();
    const outside = await temporaryDirectory();
    const blocksFile = resolve(workspace, "prompt-blocks.log");
    await fs.writeFile(resolve(outside, "secret.png"), ONE_PIXEL_PNG);
    await fs.writeFile(resolve(workspace, "notes.txt"), "not an image");
    const { base, headers } = await spawnBridge({ env: {
      CWD: workspace,
      FAKE_ACP_PROMPT_BLOCKS_FILE: blocksFile,
    } });
    const created = await nativeFetch(`${base}/session/create`, { method: "POST", headers })
      .then((response) => response.json()) as { id: string };
    const send = (attachment: unknown) => nativeFetch(`${base}/session/${created.id}/prompt`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        prompt: "DIRECT:describe it",
        requestId: "rejected-1",
        attachments: [attachment],
      }),
    });

    const escaped = await send({ type: "image", path: resolve(outside, "secret.png") });
    expect(escaped.status).toBe(400);
    expect(await escaped.json()).toMatchObject({
      error: expect.stringContaining("workspace") as never,
    });

    const notAnImage = await send({ type: "image", path: "notes.txt" });
    expect(notAnImage.status).toBe(400);

    const notAnAttachment = await send({ type: "file", path: "notes.txt" });
    expect(notAnAttachment.status).toBe(400);

    // A rejected attachment never started a turn, so the same requestId must
    // still be dispatchable rather than parked as an accepted prompt.
    await fs.writeFile(resolve(workspace, "ok.png"), ONE_PIXEL_PNG);
    const accepted = await send({ type: "image", path: "ok.png" });
    expect(accepted.status).toBe(202);
    await waitFor(
      () => nativeFetch(`${base}/session/${created.id}`, { headers })
        .then((response) => response.json()) as Promise<{ status: string }>,
      (session) => session.status === "idle",
    );
    expect((await fs.readFile(blocksFile, "utf8")).trim().split("\n")).toHaveLength(1);
  });

});
