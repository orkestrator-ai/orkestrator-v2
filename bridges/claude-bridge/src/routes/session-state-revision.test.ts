// The state revision's harness (to-do 8102 task 2, design D7): every mutation
// path these tests drive must move the revision the observe stream carries
// whenever it changes what the backend's state read returns. Driven through
// the bridge's real composition root and session manager, with only the
// Claude SDK and filesystem edges mocked by the shared harness.
import { afterAll, describe, expect, test } from "bun:test";
import { expectStateRevisionMoves } from "@orkestrator/protocol/node/bridge-state-revision";
import {
  createSession,
  getPendingInteractions,
  getPendingPlanApprovals,
  getPendingQuestions,
  nextQueryCall,
  respondToPlanApproval,
  sendPrompt,
  track,
  waitFor,
} from "../services/session-manager-test-harness.js";
import { sessionStateRevisions } from "../services/state-revision.js";
import { observationFrameData } from "./events.js";

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

/** What the backend's state read gets: the body (minus liveness) and the side routes. */
async function stateRead(sessionId: string): Promise<unknown> {
  const base = `/session/${sessionId}`;
  const [session, questions, planApprovals, interactions] = await Promise.all(
    ["", "/questions", "/plan-approvals", "/interactions"].map(async (path) => {
      const response = await app.request(`${base}${path}`);
      return (await response.json()) as Record<string, unknown>;
    }),
  );
  const { lastActivity: _lastActivity, stateRevision: _stateRevision, ...state } = session!;
  return { state, questions, planApprovals, interactions };
}

function harness(sessionId: string) {
  return (label: string, mutate: () => unknown | Promise<unknown>) =>
    expectStateRevisionMoves({
      label,
      read: () => stateRead(sessionId),
      peek: () => sessionStateRevisions.peek(sessionId),
      mutate,
    });
}

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Claude state revision", () => {
  test("every driven mutation that changes the state read moves the revision", async () => {
    const session = createSession("state-revision-harness");
    track(session.id);
    const check = harness(session.id);
    const changed: string[] = [];
    const record = async (label: string, mutate: () => unknown | Promise<unknown>) => {
      if ((await check(label, mutate)).changed) changed.push(label);
    };

    let prompt!: Promise<unknown>;
    await record("prompt start", async () => {
      prompt = sendPrompt(session.id, "go", { permissionMode: "plan", approvalMode: "default" });
      await waitFor(() => session.status === "running");
    });
    const call = await nextQueryCall();

    let questionDecision!: Promise<unknown>;
    await record("question parked", async () => {
      questionDecision = call.options.canUseTool!("AskUserQuestion", {
        questions: [{ question: "Which?", header: "Pick", options: [] }],
      }) as Promise<unknown>;
      await waitFor(() => getPendingQuestions(session.id).length === 1);
    });
    const [question] = getPendingQuestions(session.id);
    await record("question held", () =>
      post(`/session/${session.id}/questions/${question!.id}/hold`, { held: true }),
    );
    await record("question answered", async () => {
      await post(`/session/${session.id}/questions/${question!.id}/answer`, {
        answers: [["this"]],
      });
      await waitFor(() => getPendingQuestions(session.id).length === 0);
    });
    await questionDecision.catch(() => undefined);

    let planDecision!: Promise<unknown>;
    await record("plan approval parked", async () => {
      planDecision = call.options.canUseTool!("ExitPlanMode", {
        plan: "do stuff",
      }) as Promise<unknown>;
      await waitFor(() => getPendingPlanApprovals(session.id).length === 1);
    });
    await record("plan approved", async () => {
      const [approval] = getPendingPlanApprovals(session.id);
      respondToPlanApproval(approval!.id, true);
      await planDecision;
    });

    session.executionPolicy = {
      id: "interactive-host",
      sandbox: "none",
      approvals: "ask",
      projectResources: true,
      networkAccess: "full",
    };
    let toolDecision!: Promise<unknown>;
    await record("tool approval parked", async () => {
      toolDecision = call.options.canUseTool!("Bash", { command: "ls" }, {
        signal: new AbortController().signal,
        requestId: "state-revision-approval",
      } as never) as Promise<unknown>;
      await waitFor(() => getPendingInteractions(session.id).length === 1);
    });
    await record("tool approval answered", async () => {
      await post(`/session/${session.id}/interactions/state-revision-approval`, {
        action: "accept",
      });
      await toolDecision;
    });

    await record("rate limit", async () => {
      call.push({
        type: "rate_limit_event",
        rate_limit_info: { rateLimitType: "five_hour", utilization: 0.5 },
      } as never);
      await waitFor(() => (session.rateLimits?.length ?? 0) > 0);
    });

    await record("turn finished", async () => {
      call.push({ type: "result", subtype: "success" } as never);
      call.finish();
      await prompt;
    });

    await record("title", () => post(`/session/${session.id}/title`, { title: "Renamed" }));

    // The harness only proves something if the paths really changed the read.
    expect(changed).toEqual(
      expect.arrayContaining([
        "prompt start",
        "question parked",
        "question answered",
        "plan approval parked",
        "tool approval parked",
        "turn finished",
        "title",
      ]),
    );
  });

  test("a current knownStateRevision gets the small unchanged answer", async () => {
    const session = createSession("state-revision-conditional");
    track(session.id);
    const full = (await (await app.request(`/session/${session.id}`)).json()) as {
      stateRevision?: string;
      status?: string;
    };
    expect(full.stateRevision).toMatch(/:\d+$/);
    expect(full.status).toBe("idle");

    const known = encodeURIComponent(full.stateRevision!);
    const again = await app.request(`/session/${session.id}?knownStateRevision=${known}`);
    expect(await again.json()).toEqual({ unchanged: true, stateRevision: full.stateRevision });

    await post(`/session/${session.id}/title`, { title: "Moved" });
    const moved = (await (
      await app.request(`/session/${session.id}?knownStateRevision=${known}`)
    ).json()) as { stateRevision?: string; title?: string; unchanged?: boolean };
    expect(moved.unchanged).toBeUndefined();
    expect(moved.title).toBe("Moved");
    expect(moved.stateRevision).not.toBe(full.stateRevision);

    // An unknown revision is answered in full, never `unchanged`.
    const stale = (await (
      await app.request(`/session/${session.id}?knownStateRevision=other%3A1`)
    ).json()) as { status?: string };
    expect(stale.status).toBe("idle");
  });

  test("observe frame data carries the session's current revisions", () => {
    const session = createSession("state-revision-frame");
    track(session.id);
    const before = JSON.parse(observationFrameData(session.id)) as Record<string, string>;
    expect(before.sessionId).toBe(session.id);
    expect(before.stateRevision).toBe(sessionStateRevisions.peek(session.id));
    expect(typeof before.transcriptRevision).toBe("string");
    sessionStateRevisions.bump(session.id);
    const after = JSON.parse(observationFrameData(session.id)) as Record<string, string>;
    expect(after.stateRevision).not.toBe(before.stateRevision);
    expect(after.transcriptRevision).toBe(before.transcriptRevision);
    expect(observationFrameData(undefined)).toBe("{}");
  });
});
