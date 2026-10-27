// Drives `/session/:id/interactions` through the bridge's real composition root
// and the real session manager, with only the Claude SDK and filesystem edges
// mocked by the shared harness.
import { afterAll, describe, expect, test } from "bun:test";

import {
  createSession,
  getPendingInteractions,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "../services/session-manager-test-harness.js";

const envKeys = ["CLAUDE_BRIDGE_NO_SERVER", "CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
// The bridge skips `serve()` and its token check only under both flags.
for (const key of envKeys) process.env[key] = "1";
const { app } = await import("../index.js");

afterAll(() => {
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function respond(sessionId: string, interactionId: string, body: unknown) {
  return app.request(`/session/${sessionId}/interactions/${interactionId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A running turn with one parked form elicitation, plus its pending result. */
async function parkedForm(name: string) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  const result = call.options.onElicitation!(
    {
      serverName: "linear",
      message: "Which team?",
      mode: "form",
      requestedSchema: { type: "object", properties: { team: { type: "string" } } },
    },
    { signal: new AbortController().signal, requestId: `${name}-request` },
  );
  await waitFor(() => getPendingInteractions(session.id).length === 1);
  const finish = async () => {
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  };
  return { session, call, result, interactionId: `${name}-request`, finish };
}

describe("/session/:id/interactions", () => {
  test("lists a parked elicitation and passes the answer to the server", async () => {
    const { session, result, interactionId, finish } = await parkedForm("route-answer");

    const listed = await app.request(`/session/${session.id}/interactions`);
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { interactions: unknown }).interactions).toEqual([
      expect.objectContaining({ id: interactionId, kind: "mcp-form", serverName: "linear" }),
    ]);

    const answered = await respond(session.id, interactionId, {
      action: "accept",
      content: { team: "core" },
    });
    expect(answered.status).toBe(200);
    expect(await result).toEqual({ action: "accept", content: { team: "core" } });

    // Answered is closed: a repeat is stale, not missing.
    const repeat = await respond(session.id, interactionId, { action: "decline" });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ status: "stale" });
    await finish();
  });

  test("refuses a malformed answer and leaves the request parked", async () => {
    const { session, call, result, interactionId, finish } = await parkedForm("route-invalid");

    for (const body of [
      { action: "approve" },
      { action: "accept" },
      { action: "accept", content: { team: { nested: true } } },
      { action: "accept", content: { team: 42 } },
      { action: "accept", content: { unknown: "value" } },
      { action: "decline", content: { team: "core" } },
    ]) {
      expect((await respond(session.id, interactionId, body)).status).toBe(400);
    }
    expect(getPendingInteractions(session.id)).toHaveLength(1);

    // Content belongs to MCP requests only, never to a tool approval.
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    };
    const decision = call.options.canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      requestId: "route-approval",
    } as never);
    await waitFor(() => getPendingInteractions(session.id).length === 2);
    const withContent = await respond(session.id, "route-approval", {
      action: "accept",
      content: { team: "core" },
    });
    expect(withContent.status).toBe(400);
    expect((await respond(session.id, "route-approval", { action: "accept" })).status).toBe(200);
    expect(await decision).toEqual({ behavior: "allow", updatedInput: { command: "ls" } });

    await respond(session.id, interactionId, { action: "cancel" });
    expect(await result).toEqual({ action: "cancel" });
    await finish();
  });

  test("lists a url sign-in, a file approval and a permission, and answers each", async () => {
    const session = createSession("route-kinds");
    track(session.id);
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    };
    const prompt = sendPrompt(session.id, "go");
    const call = await nextQueryCall();
    const signal = new AbortController().signal;
    const link = call.options.onElicitation!(
      {
        serverName: "linear",
        message: "Authorize",
        mode: "url",
        url: "https://linear.app/oauth",
        elicitationId: "e-route",
      },
      { signal, requestId: "route-url" },
    );
    const file = call.options.canUseTool!(
      "Edit",
      { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
      { signal, requestId: "route-file", toolUseID: "tu-file" } as never,
    );
    const permission = call.options.canUseTool!("mcp__linear__create_issue", { title: "Bug" }, {
      signal,
      requestId: "route-permission",
      mcpServer: { name: "linear", source: "user" },
    } as never);
    await waitFor(() => getPendingInteractions(session.id).length === 3);

    const listed = await app.request(`/session/${session.id}/interactions`);
    expect(listed.status).toBe(200);
    const { interactions } = (await listed.json()) as {
      interactions: Array<Record<string, unknown>>;
    };
    expect(interactions).toEqual([
      expect.objectContaining({
        id: "route-url",
        kind: "mcp-url",
        serverName: "linear",
        url: "https://linear.app/oauth",
        elicitationId: "e-route",
      }),
      expect.objectContaining({
        id: "route-file",
        kind: "file-approval",
        toolName: "Edit",
        toolUseId: "tu-file",
        paths: ["/repo/a.ts"],
      }),
      expect.objectContaining({
        id: "route-permission",
        kind: "permission",
        toolName: "mcp__linear__create_issue",
        mcpServer: "linear",
        input: '{"title":"Bug"}',
      }),
    ]);
    // Every card carries the deadline the backend renders as a countdown.
    for (const interaction of interactions) {
      expect(interaction.expiresAt as number).toBeGreaterThan(interaction.requestedAt as number);
    }

    expect((await respond(session.id, "route-url", { action: "accept" })).status).toBe(200);
    expect(await link).toEqual({ action: "accept" });
    expect((await respond(session.id, "route-file", { action: "accept" })).status).toBe(200);
    expect(await file).toEqual({
      behavior: "allow",
      updatedInput: { file_path: "/repo/a.ts", old_string: "a", new_string: "b" },
    });
    expect((await respond(session.id, "route-permission", { action: "decline" })).status).toBe(200);
    expect(await permission).toEqual({
      behavior: "deny",
      message: "The user denied this tool call.",
    });
    expect(getPendingInteractions(session.id)).toEqual([]);

    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  });

  test("an unknown interaction is stale and an unknown session is 404", async () => {
    const session = createSession("route-unknown");
    track(session.id);

    const unknown = await respond(session.id, "never-parked", { action: "decline" });
    expect(unknown.status).toBe(409);
    expect((await app.request("/session/no-such-session/interactions")).status).toBe(404);
  });
});

for (const mode of ["form", "url"] as const) {
  test(`Cancel turn on an MCP ${mode} stops the runtime and settles sibling cards`, async () => {
    const { session, call, result, interactionId, finish } = await parkedForm(`cancel-${mode}`);
    const sibling = call.options.onElicitation!(
      { serverName: "linear", message: "Authorize", mode: "url", url: "https://example.com/auth" },
      { signal: new AbortController().signal, requestId: `sibling-${mode}` },
    );
    await waitFor(() => getPendingInteractions(session.id).length === 2);
    const runtime = session.claudeRuntime!;
    const id = mode === "form" ? interactionId : `sibling-${mode}`;
    expect((await respond(session.id, id, { action: "cancel" })).status).toBe(200);
    expect(await result).toEqual({ action: "cancel" });
    expect(await sibling).toEqual({ action: "cancel" });
    expect(runtime.abortController.signal.aborted).toBe(true);
    expect(call.isClosed()).toBe(true);
    expect(getPendingInteractions(session.id)).toHaveLength(0);
    await finish();
  });
}

test("concurrent large forms stay readable and answerable through backend normalization", async () => {
  const { HttpBridgeInteractionAdapter } =
    await import("../../../../apps/backend/src/core/http-bridge-interactions.js");
  const session = createSession("route-saturation");
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  const results = new Map<string, unknown>();
  const waits = Array.from({ length: 18 }, (_, i) => {
    const id = `large-${i}`;
    const pending = call.options.onElicitation!(
      {
        serverName: "linear",
        message: "Input",
        mode: "form",
        requestedSchema: {
          type: "object",
          properties: { team: { type: "string", description: "界".repeat(5000) } },
          required: ["team"],
        },
      },
      { signal: new AbortController().signal, requestId: id },
    );
    return Promise.resolve(pending).then((value) => {
      results.set(id, value);
      return value;
    });
  });
  const admitted = getPendingInteractions(session.id);
  expect(admitted.length).toBeGreaterThan(0);
  expect(admitted.length).toBeLessThan(18);
  await waitFor(() => results.size === 18 - admitted.length);
  expect(
    Array.from(results.values()).every(
      (value) => (value as { action: string }).action === "decline",
    ),
  ).toBe(true);
  const adapter = new HttpBridgeInteractionAdapter(
    "claude",
    { agent: "claude", baseUrl: "http://fixture", authToken: "fixture" },
    ((input, init) => app.request(String(input), init)) as typeof fetch,
  );
  const snapshot = await adapter.listPendingInteractions(session.id);
  expect(snapshot.requests).toHaveLength(admitted.length);
  for (const card of snapshot.requests) {
    expect(
      await adapter.resolveInteraction(session.id, card.id, {
        version: 1,
        interactionId: card.id,
        sessionId: session.id,
        action: "answer",
        resolvedAt: Date.now(),
        answer: {
          version: 1,
          interactionId: card.id,
          sessionId: session.id,
          answers: [
            {
              questionId: card.presentation.questions[0]!.id,
              freeText: JSON.stringify({ team: "core" }),
            },
          ],
        },
      }),
    ).toMatchObject({ result: "applied" });
  }
  expect((await adapter.listPendingInteractions(session.id)).requests).toHaveLength(0);
  await Promise.all(waits);
  call.push({ type: "result", subtype: "success" });
  call.finish();
  await prompt;
});
