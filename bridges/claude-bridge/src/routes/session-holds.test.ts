// Drives the hold routes through the bridge's real composition root and the
// real session manager, with only the Claude SDK and filesystem edges mocked.
import { afterAll, describe, expect, test } from "bun:test";
import { AGENT_INTERACTION_HOLD_CEILING_MS } from "@orkestrator/protocol/agent-interactions";

import {
  createSession,
  dismissQuestion,
  getPendingInteractions,
  getPendingQuestions,
  nextQueryCall,
  sendPrompt,
  track,
  waitFor,
} from "../services/session-manager-test-harness.js";

const envKeys = ["CLAUDE_BRIDGE_NO_SERVER", "CLAUDE_BRIDGE_AUTH_DISABLED_FOR_TESTING"] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) process.env[key] = "1";
const { app } = await import("../index.js");

afterAll(() => {
  for (const key of envKeys) {
    const original = originalEnv[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function hold(sessionId: string, path: string, body: unknown) {
  return app.request(`/session/${sessionId}/${path}/hold`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function runningTurn(name: string) {
  const session = createSession(name);
  track(session.id);
  const prompt = sendPrompt(session.id, "go");
  const call = await nextQueryCall();
  const finish = async () => {
    call.push({ type: "result", subtype: "success" });
    call.finish();
    await prompt;
  };
  return { session, call, finish };
}

describe("POST /session/:id/{family}/:requestId/hold", () => {
  test("pauses and resumes a question, and the snapshot shows it", async () => {
    const { session, call, finish } = await runningTurn("route-hold-question");
    const decision = call.options.canUseTool!("AskUserQuestion", {
      questions: [{ question: "Which?", header: "Pick", options: [] }],
    });
    await waitFor(() => getPendingQuestions(session.id).length === 1);
    const [question] = getPendingQuestions(session.id);

    const before = Date.now();
    const paused = await hold(session.id, `questions/${question!.id}`, { held: true });
    expect(paused.status).toBe(200);
    const body = (await paused.json()) as { status: string; expiresAt: number; hold: unknown };
    expect(body.status).toBe("applied");
    expect(body.hold).toEqual({ available: true, heldAt: expect.any(Number) });
    expect(body.expiresAt).toBeGreaterThanOrEqual(before + AGENT_INTERACTION_HOLD_CEILING_MS);

    const listed = (await (await app.request(`/session/${session.id}/questions`)).json()) as {
      questions: Array<{ id: string; expiresAt: number; requestedAt: number; hold: unknown }>;
    };
    expect(listed.questions).toEqual([
      expect.objectContaining({
        id: question!.id,
        expiresAt: body.expiresAt,
        requestedAt: question!.requestedAt,
        hold: body.hold,
      }),
    ]);

    const repeat = await hold(session.id, `questions/${question!.id}`, { held: true });
    expect(await repeat.json()).toMatchObject({ status: "unchanged" });

    const resumed = await hold(session.id, `questions/${question!.id}`, { held: false });
    expect(await resumed.json()).toMatchObject({ status: "applied", hold: { available: true } });

    // A hold answers nothing: the question is still waiting.
    expect(getPendingQuestions(session.id)).toHaveLength(1);
    dismissQuestion(question!.id);
    await decision;
    await finish();
  });

  test("pauses a tool approval on the interactions family", async () => {
    const { session, call, finish } = await runningTurn("route-hold-approval");
    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    };
    const decision = call.options.canUseTool!("Bash", { command: "ls" }, {
      signal: new AbortController().signal,
      requestId: "route-hold-approval-request",
    } as never);
    await waitFor(() => getPendingInteractions(session.id).length === 1);

    const paused = await hold(session.id, "interactions/route-hold-approval-request", {
      held: true,
    });
    expect(await paused.json()).toMatchObject({ status: "applied" });
    const listed = (await (await app.request(`/session/${session.id}/interactions`)).json()) as {
      interactions: Array<{ hold: unknown }>;
    };
    expect(listed.interactions[0]?.hold).toEqual({ available: true, heldAt: expect.any(Number) });

    await app.request(`/session/${session.id}/interactions/route-hold-approval-request`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decline" }),
    });
    expect(await decision).toMatchObject({ behavior: "deny" });
    await finish();
  });

  test("refuses a malformed body, and answers stale or missing like the answer routes", async () => {
    const { session, finish } = await runningTurn("route-hold-invalid");
    for (const body of [{}, { held: "yes" }, "not json"]) {
      expect((await hold(session.id, "questions/anything", body)).status).toBe(400);
    }
    const stale = await hold(session.id, "plan-approvals/never-parked", { held: true });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ status: "stale" });
    expect((await hold("session-missing", "questions/anything", { held: true })).status).toBe(404);
    await finish();
  });
});
