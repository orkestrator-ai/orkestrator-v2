import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { CONTROL_MCP_VOICE_TOOLS_BUDGET_BYTES } from "@orkestrator/protocol/control-mcp";
import { PUBLIC_ACTIONS } from "@orkestrator/protocol/public-api";
import { PUBLIC_ACTION_INPUTS } from "@orkestrator/protocol/public-api-inputs";
import { DIRECT_TOOL_ACTIONS, directToolName } from "./control-mcp-direct-tools.js";
import { GATEWAY_TOOL_NAMES } from "./control-mcp-gateway.js";
import { OPERATOR_TOOL_ACTIONS } from "./control-mcp-operator-tools.js";
import { controlMcpHarness } from "./control-mcp-test-support.js";
import { VOICE_CORE_TOOL_NAMES, VOICE_TOOL_ACTIONS } from "./control-mcp-voice.js";
import { cleanupSessionHarnesses, setActivity } from "./public-api/test-provider.js";

/**
 * The operator profiles over the real public-action stack: exact tool lists,
 * the voice budget, gateway reachability of every action, confirmation
 * tokens, authority isolation and the voice core tools.
 */

const harnesses: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.close();
  await cleanupSessionHarnesses();
});

async function open() {
  const harness = await controlMcpHarness();
  harnesses.push(harness);
  return harness;
}

const VOICE_TOOLS = [
  "overview",
  "resolve_target",
  "read_session",
  "prompt_session",
  "steer_session",
  "stop_session",
  "answer_question",
  "start_work",
  "find_actions",
  "describe_action",
  "run_action",
  "run_status",
];
const LEGACY_TOOLS = Object.keys(OPERATOR_TOOL_ACTIONS);

function structured(result: { structuredContent?: Record<string, unknown> }) {
  return result.structuredContent as {
    ok: boolean;
    action: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string; exitCode: number; details?: Record<string, unknown> };
    receipt?: { operationId: string; state: string; requestId: string };
    backend?: unknown;
  };
}

async function startSession(harness: Awaited<ReturnType<typeof open>>, requestId: string) {
  const started = await harness.harness.call<{ sessionId: string; tabId: string; runId: string }>(
    "session.start",
    { environmentId: "env-1", agent: "claude", prompt: "work" },
    { requestId },
  );
  if (!started.ok) throw new Error(started.error.message);
  return { ...started.result, providerSessionId: harness.stub.sends.at(-1)!.sessionId };
}

function approval(providerSessionId: string, id = "approval-1"): AgentInteractionRequest {
  return {
    version: 1,
    id,
    provider: "claude",
    kind: "command-approval",
    origin: "interactive-native",
    sessionId: providerSessionId,
    state: "pending",
    revision: 2,
    presentation: { title: "Run rm -rf dist", body: "rm -rf dist", questions: [] },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
  } as unknown as AgentInteractionRequest;
}

describe("Control MCP profiles", () => {
  test("each profile lists exactly its tools, in a stable order", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const readOnly = await harness.credential("read-only");
    const custom = await harness.credential("custom", { capabilities: ["sessions.read"] });

    expect((await harness.list(voice.token)).tools.map((tool) => tool.name)).toEqual(VOICE_TOOLS);
    expect(VOICE_CORE_TOOL_NAMES).toEqual(VOICE_TOOLS.slice(0, 8));
    expect<string[]>([...GATEWAY_TOOL_NAMES]).toEqual(VOICE_TOOLS.slice(8));

    const direct = DIRECT_TOOL_ACTIONS.map(directToolName);
    expect((await harness.list(harness.defaultToken)).tools.map((tool) => tool.name)).toEqual([
      ...LEGACY_TOOLS,
      ...VOICE_TOOLS,
      ...direct,
    ]);

    const reads = (actions: readonly string[]) =>
      actions.every((action) => !PUBLIC_ACTIONS[action as keyof typeof PUBLIC_ACTIONS].mutation);
    expect((await harness.list(readOnly.token)).tools.map((tool) => tool.name)).toEqual([
      ...LEGACY_TOOLS.filter((tool) => reads(OPERATOR_TOOL_ACTIONS[tool]!)),
      "overview",
      "resolve_target",
      "read_session",
      ...GATEWAY_TOOL_NAMES,
      ...DIRECT_TOOL_ACTIONS.filter((action) => !PUBLIC_ACTIONS[action].mutation).map(
        directToolName,
      ),
    ]);

    // A custom credential sees only what its capabilities reach.
    const customTools = (await harness.list(custom.token)).tools.map((tool) => tool.name);
    expect(customTools).toEqual([
      "list_tabs",
      "list_agents",
      "get_tab_state",
      "get_tab_transcript",
      "list_multi_reviews",
      "get_multi_review",
      "overview",
      "read_session",
      ...GATEWAY_TOOL_NAMES,
      ...DIRECT_TOOL_ACTIONS.filter(
        (action) => PUBLIC_ACTION_INPUTS[action].capability === "sessions.read",
      ).map(directToolName),
    ]);
  });

  test("tool names are portable and the voice list fits its budget", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const voiceList = await harness.list(voice.token);
    const fullList = await harness.list(harness.defaultToken);
    for (const tool of [...voiceList.tools, ...fullList.tools]) {
      expect(tool.name).toMatch(/^[a-z0-9_]{1,64}$/);
    }
    expect(voiceList.bytes).toBeLessThanOrEqual(CONTROL_MCP_VOICE_TOOLS_BUDGET_BYTES);
    // The full profile is reported, not capped; it is far larger than voice.
    expect(fullList.bytes).toBeGreaterThan(voiceList.bytes * 4);
  });

  test("every direct and core tool names the public actions it uses", async () => {
    const harness = await open();
    const listed = (await harness.list(harness.defaultToken)).tools;
    for (const action of DIRECT_TOOL_ACTIONS) {
      const tool = listed.find((candidate) => candidate.name === directToolName(action));
      expect(tool?.description).toContain(`(public action ${action})`);
    }
    for (const [tool, actions] of Object.entries(OPERATOR_TOOL_ACTIONS)) {
      expect({ tool, actions: actions.filter((action) => !(action in PUBLIC_ACTIONS)) }).toEqual({
        tool,
        actions: [],
      });
    }
    for (const [tool, entry] of Object.entries(VOICE_TOOL_ACTIONS)) {
      const named = [...entry.actions, ...(entry.listedWith ?? [])];
      expect({ tool, unknown: named.filter((action) => !(action in PUBLIC_ACTIONS)) }).toEqual({
        tool,
        unknown: [],
      });
      expect((entry.listedWith ?? []).every((action) => entry.actions.includes(action))).toBe(true);
    }
  });

  test("every public action an MCP credential can hold is reachable through run_action", async () => {
    const harness = await open();
    for (const action of DIRECT_TOOL_ACTIONS) {
      const mutation = PUBLIC_ACTIONS[action].mutation;
      // An empty input reaches the handler and fails its own validation,
      // before any side effect; a backend identity proves it was dispatched.
      const call = (confirmToken?: string) =>
        harness.call(harness.defaultToken, "run_action", {
          action,
          input: { invalidField: true },
          ...(mutation ? { requestId: `reach-${action}` } : {}),
          ...(confirmToken ? { confirmToken } : {}),
        });
      let envelope = structured(await call());
      if (envelope.error?.code === "confirmation-required") {
        envelope = structured(await call(String(envelope.error.details?.confirmToken)));
      }
      expect({ action, dispatched: envelope.backend !== undefined }).toEqual({
        action,
        dispatched: true,
      });
      expect({ action, code: envelope.error?.code }).toEqual({ action, code: "invalid-input" });
    }
    const host = structured(
      await harness.call(harness.defaultToken, "run_action", { action: "host.status", input: {} }),
    );
    expect(host.error?.code).toBe("capability-unavailable");
    expect(host.backend).toBeUndefined();
  });
});

describe("Control MCP gateway", () => {
  test("find_actions ranks matches and says what the credential may call", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const found = structured(
      await harness.call(voice.token, "find_actions", { query: "delete environment" }),
    ).result as { items: Array<{ action: string; allowed: boolean; confirmation: string }> };
    expect(found.items[0]).toMatchObject({
      action: "environment.delete",
      allowed: false,
      confirmation: "always",
    });
    expect(found.items.length).toBeLessThanOrEqual(15);
    const grouped = structured(
      await harness.call(voice.token, "find_actions", { group: "session" }),
    ).result as { items: Array<{ action: string }> };
    expect(grouped.items.every((item) => item.action.startsWith("session."))).toBe(true);
  });

  test("describe_action returns the schema, examples and CLI equivalent", async () => {
    const harness = await open();
    const described = structured(
      await harness.call(harness.defaultToken, "describe_action", { action: "session.prompt" }),
    ).result!;
    expect(described).toMatchObject({
      action: "session.prompt",
      mutation: true,
      requestId: "required",
      capability: "sessions.control",
      cli: "orkestrator session prompt",
      input: PUBLIC_ACTION_INPUTS["session.prompt"].input,
    });
    expect((described.examples as unknown[]).length).toBeGreaterThan(0);
    const host = structured(
      await harness.call(harness.defaultToken, "describe_action", { action: "host.status" }),
    );
    expect(host.error?.code).toBe("unsupported");
  });

  test("run_action applies the request-key rule before dispatch", async () => {
    const harness = await open();
    const noKey = structured(
      await harness.call(harness.defaultToken, "run_action", {
        action: "session.prompt",
        input: { sessionId: "ses_x", prompt: "hi" },
      }),
    );
    expect(noKey.error?.code).toBe("invalid-input");
    expect(noKey.backend).toBeUndefined();
    const readWithKey = structured(
      await harness.call(harness.defaultToken, "run_action", {
        action: "project.list",
        input: {},
        requestId: "not-for-reads",
      }),
    );
    expect(readWithKey.error?.code).toBe("invalid-input");
    const unknown = structured(
      await harness.call(harness.defaultToken, "run_action", { action: "invoke", input: {} }),
    );
    expect(unknown.error?.code).toBe("unsupported");
  });

  test("run_status reads a run and stops early on a pending interaction", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const started = structured(
      await harness.call(voice.token, "start_work", {
        environmentId: "env-1",
        agent: "claude",
        prompt: "work",
        requestId: "status-run",
      }),
    );
    const operationId = started.receipt!.operationId;
    const running = await harness.call(voice.token, "run_status", { operationId });
    expect(structured(running).receipt?.state).toBe("running");
    expect(running.content?.[0]?.text).toContain("still running");

    const tabId = (started.result as { tabId: string }).tabId;
    const providerSessionId = harness.stub.sends.at(-1)!.sessionId;
    harness.stub.pending.push(approval(providerSessionId));
    setActivity(harness.service, "claude", tabId, providerSessionId, "waiting");
    const waited = Date.now();
    const waiting = await harness.call(voice.token, "run_status", { operationId, waitSeconds: 5 });
    expect(Date.now() - waited).toBeLessThan(4_000);
    expect(waiting.structuredContent?.wait).toMatchObject({ verdict: "stopped" });
    expect(waiting.content?.[0]?.text).toContain("answer_question");

    const byKey = structured(
      await harness.call(voice.token, "run_status", {
        requestId: "status-run",
        action: "session.start",
      }),
    );
    expect(byKey.receipt?.operationId).toBe(operationId);
  });
});

describe("Control MCP confirmation", () => {
  test("a confirm token is bound to the credential, the action and the exact input", async () => {
    const harness = await open();
    const voice = await harness.credential("voice", {
      capabilities: ["discovery", "environments.lifecycle", "exec"],
    });
    const other = await harness.credential("voice", {
      capabilities: ["discovery", "environments.lifecycle", "exec"],
      label: "second voice client",
    });
    const input = { environmentId: "env-1", argv: ["true"] };
    const first = structured(
      await harness.call(voice.token, "run_action", {
        action: "environment.exec",
        input,
        requestId: "exec-1",
      }),
    );
    expect(first.error).toMatchObject({ code: "confirmation-required", exitCode: 6 });
    expect(String(first.error?.details?.description)).toContain(
      "runs `true` in environment sessions",
    );
    const token = String(first.error?.details?.confirmToken);
    expect(token).toMatch(/^ct1\./);

    // Another credential cannot use it, and a changed input is a new request.
    const replayed = structured(
      await harness.call(other.token, "run_action", {
        action: "environment.exec",
        input,
        requestId: "exec-1",
        confirmToken: token,
      }),
    );
    expect(replayed.error).toMatchObject({
      code: "confirmation-required",
      details: { refused: "mismatch" },
    });
    const changed = structured(
      await harness.call(voice.token, "run_action", {
        action: "environment.exec",
        input: { ...input, argv: ["rm", "-rf", "dist"] },
        requestId: "exec-1",
        confirmToken: token,
      }),
    );
    expect(changed.error).toMatchObject({
      code: "confirmation-required",
      details: { refused: "mismatch" },
    });

    const confirmed = structured(
      await harness.call(voice.token, "run_action", {
        action: "environment.exec",
        input,
        requestId: "exec-1",
        confirmToken: token,
      }),
    );
    expect(confirmed.error?.code).not.toBe("confirmation-required");
    expect(confirmed.backend).toBeDefined();

    const newRequest = structured(
      await harness.call(voice.token, "run_action", {
        action: "environment.exec",
        input,
        requestId: "exec-2",
        confirmToken: token,
      }),
    );
    expect(newRequest.error).toMatchObject({
      code: "confirmation-required",
      details: { refused: "mismatch" },
    });
  });

  test("voice approvals confirm, while denials and question answers run directly", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const session = await startSession(harness, "approve-run");
    harness.stub.pending.push(approval(session.providerSessionId));
    setActivity(harness.service, "claude", session.tabId, session.providerSessionId, "waiting");

    const overview = await harness.call(voice.token, "overview");
    expect(overview.content?.[0]?.text).toContain("claude in sessions is asking: Run rm -rf dist");

    const answer = {
      sessionId: session.sessionId,
      interactionId: "approval-1",
      revision: 2,
      action: "answer",
      requestId: "approve-1",
    };
    const asked = structured(await harness.call(voice.token, "answer_question", answer));
    expect(asked.error?.code).toBe("confirmation-required");
    expect(String(asked.error?.details?.description)).toBe(
      "This approves Run rm -rf dist: rm -rf dist.",
    );
    expect(harness.stub.resolutions).toHaveLength(0);
    const approved = structured(
      await harness.call(voice.token, "answer_question", {
        ...answer,
        confirmToken: asked.error?.details?.confirmToken,
      }),
    );
    expect(approved.ok).toBe(true);
    expect(harness.stub.resolutions).toHaveLength(1);

    // A denial needs no confirmation.
    harness.stub.pending.push(approval(session.providerSessionId, "approval-2"));
    const denied = structured(
      await harness.call(voice.token, "answer_question", {
        ...answer,
        interactionId: "approval-2",
        action: "deny",
        requestId: "deny-2",
      }),
    );
    expect(denied.ok).toBe(true);
    expect(harness.stub.resolutions).toHaveLength(2);
  });

  test("the full profile runs voice-class actions without a token, never always-class ones", async () => {
    const harness = await open();
    const stop = structured(
      await harness.call(harness.defaultToken, "environment_stop", {
        environmentId: "missing-environment",
        requestId: "stop-missing",
      }),
    );
    expect(stop.error?.code).toBe("not-found");
    const remove = structured(
      await harness.call(harness.defaultToken, "project_remove", {
        projectId: "missing-project",
        requestId: "remove-missing",
      }),
    );
    expect(remove.error?.code).toBe("confirmation-required");
  });
});

describe("Control MCP authority", () => {
  test("credentials and the CLI cannot read or collide with each other's operations", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const second = await harness.credential("voice", { label: "second" });

    // The CLI (operator) starts a session under request ID "shared-key".
    const cli = await startSession(harness, "shared-key");
    const hidden = structured(
      await harness.call(voice.token, "run_status", { operationId: cli.runId }),
    );
    expect(hidden.error?.code).toBe("not-found");

    // The same request ID from a credential is a different request, not a conflict.
    const mine = structured(
      await harness.call(voice.token, "start_work", {
        environmentId: "env-1",
        agent: "claude",
        prompt: "a different prompt",
        requestId: "shared-key",
      }),
    );
    expect(mine.ok).toBe(true);
    expect(mine.receipt?.operationId).not.toBe(cli.runId);

    // Another credential sees neither by ID nor by request key.
    const crossById = structured(
      await harness.call(second.token, "run_status", { operationId: mine.receipt!.operationId }),
    );
    expect(crossById.error?.code).toBe("not-found");
    const crossByKey = structured(
      await harness.call(second.token, "run_status", {
        requestId: "shared-key",
        action: "session.start",
      }),
    );
    expect(crossByKey.error?.code).toBe("not-found");

    // The CLI's own lookups never see the credential's run either.
    const cliLookup = await harness.harness.call("run.get", {
      requestId: "shared-key",
      action: "session.start",
    });
    expect(cliLookup.receipt?.operationId).toBe(cli.runId);
    const cliById = await harness.harness.call("run.get", {
      operationId: mine.receipt!.operationId,
    });
    expect(!cliById.ok && cliById.error.code).toBe("not-found");
  });
});

describe("direct read tools", () => {
  test("run_get retains the action's requestId lookup input", async () => {
    const harness = await open();
    const created = structured(
      await harness.call(harness.defaultToken, "ticket_create", {
        projectId: harness.projectId,
        title: "Lookup",
        requestId: "lookup-ticket",
      }),
    );
    expect(created.ok).toBe(true);
    const found = structured(
      await harness.call(harness.defaultToken, "run_get", {
        requestId: "lookup-ticket",
        action: "ticket.create",
      }),
    );
    expect(found.ok).toBe(true);
    expect(found.receipt?.operationId).toBe(created.receipt?.operationId);
  });
});

describe("Control MCP voice core", () => {
  test("resolution and overview scan sessions beyond the twentieth environment", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const template = (await harness.harness.storage.loadEnvironments())[0]!;
    for (let index = 2; index <= 21; index += 1) {
      await harness.harness.storage.addEnvironment({
        ...template,
        id: `env-${index}`,
        name: `environment-${index}`,
        order: index,
      });
    }
    for (const environmentId of ["env-1", "env-21"]) {
      const launched = structured(
        await harness.call(voice.token, "start_work", {
          requestId: `scan-${environmentId}`,
          environmentId,
          agent: "claude",
          prompt: "hello",
        }),
      );
      expect(launched.ok).toBe(true);
    }
    const resolved = structured(
      await harness.call(voice.token, "resolve_target", { query: "claude", kind: "session" }),
    );
    expect(resolved.error?.code).toBe("ambiguous-target");
    const overview = structured(await harness.call(voice.token, "overview"));
    expect(overview.result).toMatchObject({
      counts: { environments: { running: 21 }, sessions: { scanned: 2 } },
    });
  });

  test("resolve_target never guesses", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const exact = structured(
      await harness.call(voice.token, "resolve_target", { query: "the sessions environment" }),
    );
    expect(exact.result).toEqual({
      target: expect.objectContaining({ kind: "environment", id: "env-1", name: "sessions" }),
    });
    const near = structured(
      await harness.call(voice.token, "resolve_target", { query: "session", kind: "environment" }),
    );
    expect(near.error?.code).toBe("ambiguous-target");
    expect(near.error?.details?.candidates).toEqual([expect.objectContaining({ id: "env-1" })]);
    const missing = structured(
      await harness.call(voice.token, "resolve_target", { query: "billing" }),
    );
    expect(missing.error?.code).toBe("not-found");

    const session = await startSession(harness, "named");
    const tab = structured(
      await harness.call(voice.token, "resolve_target", {
        query: "the first claude tab",
        environmentId: "env-1",
      }),
    );
    expect(tab.result).toEqual({
      target: expect.objectContaining({ kind: "session", id: session.sessionId }),
    });
  });

  test("read_session returns a bounded excerpt and prompt_session refuses a busy session", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const session = await startSession(harness, "read-run");
    for (let index = 0; index < 5; index += 1) {
      harness.stub.messages.push({
        id: `m-${index}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `message ${index} ${"x".repeat(2_000)}`,
        createdAt: new Date(1_000 * index).toISOString(),
        parts: [],
      });
    }
    const read = await harness.call(voice.token, "read_session", { sessionId: session.sessionId });
    const excerpt = structured(read).result as { messages: Array<{ id: string; text: string }> };
    expect(excerpt.messages.map((message) => message.id)).toEqual(["m-2", "m-3", "m-4"]);
    expect(excerpt.messages.every((message) => message.text.length <= 600)).toBe(true);
    expect(Buffer.byteLength(read.content?.[0]?.text ?? "")).toBeLessThanOrEqual(2_048);

    setActivity(harness.service, "claude", session.tabId, session.providerSessionId, "working");
    const busy = await harness.call(voice.token, "prompt_session", {
      sessionId: session.sessionId,
      prompt: "and then?",
      requestId: "busy-1",
    });
    expect(structured(busy).error?.code).toBe("busy");
    expect(busy.content?.[0]?.text).toContain("steer_session");
    expect(harness.stub.sends).toHaveLength(1);
  });

  test("start_work starts a session with the configured agent and reports IDs", async () => {
    const harness = await open();
    const voice = await harness.credential("voice");
    const started = await harness.call(voice.token, "start_work", {
      environmentId: "env-1",
      prompt: "fix it",
      requestId: "start-1",
    });
    const envelope = structured(started);
    expect(envelope.action).toBe("session.start");
    expect(envelope.receipt?.requestId).toBe("start-1");
    expect(started.content?.[0]?.text).toContain("sessionId=ses_");
    const replay = structured(
      await harness.call(voice.token, "start_work", {
        environmentId: "env-1",
        prompt: "fix it",
        requestId: "start-1",
      }),
    );
    expect(replay.receipt?.operationId).toBe(envelope.receipt?.operationId);
    expect(harness.stub.sends).toHaveLength(1);
  });
});
