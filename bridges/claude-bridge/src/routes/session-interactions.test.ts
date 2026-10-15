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

  test("an unknown interaction is stale and an unknown session is 404", async () => {
    const session = createSession("route-unknown");
    track(session.id);

    const unknown = await respond(session.id, "never-parked", { action: "decline" });
    expect(unknown.status).toBe(409);
    expect((await app.request("/session/no-such-session/interactions")).status).toBe(404);
  });
});
