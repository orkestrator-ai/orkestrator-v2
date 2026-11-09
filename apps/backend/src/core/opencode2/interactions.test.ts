import { afterEach, describe, expect, test } from "bun:test";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { FakeOpenCode2Server } from "./fake-server.test-support.js";
import { OpenCode2Provider } from "./provider.js";

let server: FakeOpenCode2Server | undefined;
let provider: OpenCode2Provider | undefined;
afterEach(async () => {
  await provider?.dispose();
  server?.stop();
  provider = undefined;
  server = undefined;
});

async function setup() {
  server = new FakeOpenCode2Server();
  provider = new OpenCode2Provider(server.client(), { monitorEvents: false });
  const sessionId = await provider.createSession("build", "x");
  return { server, provider, sessionId, session: server.sessions.get(sessionId)! };
}

function resolution(
  sessionId: string,
  interactionId: string,
  action: AgentInteractionResolution["action"],
  answers?: Array<{ questionId: string; optionIds?: string[]; freeText?: string }>,
): AgentInteractionResolution {
  return {
    version: AGENT_INTERACTION_CONTRACT_VERSION,
    interactionId,
    sessionId,
    action,
    ...(answers
      ? {
          answer: {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId,
            sessionId,
            answers,
          },
        }
      : {}),
    resolvedAt: Date.now() + 1_000,
  };
}

describe("OpenCode2InteractionAdapter", () => {
  test("a permission is an Allow once / Deny card with no session grant", async () => {
    const { provider, sessionId, session } = await setup();
    session.permissions.push({
      id: "per_1",
      sessionID: sessionId,
      action: "shell",
      resources: ["git push --force"],
    });
    // Another session's request is never shown here.
    session.permissions.push({
      id: "per_x",
      sessionID: "ses_other",
      action: "shell",
      resources: ["ls"],
    });
    const snapshot = await provider.interactions.listPendingInteractions(sessionId);
    expect(snapshot.requests).toHaveLength(1);
    const [card] = snapshot.requests;
    expect(card).toMatchObject({
      provider: "opencode",
      kind: "permission",
      sessionId,
      state: "pending",
      presentation: {
        title: "OpenCode asks to run a command",
        body: "Permission: shell\nCommand: git push --force",
        questions: [],
        confirmLabel: "Allow once",
        declineLabel: "Deny",
      },
    });
    expect(card!.presentation.approveForSessionLabel).toBeUndefined();
    // The same request read twice keeps its identity and revision.
    expect((await provider.interactions.listPendingInteractions(sessionId)).revision).toBe(
      snapshot.revision,
    );
  });

  test("allow sends once; approve-for-session is refused unsent; deny sends reject", async () => {
    const { server, provider, sessionId, session } = await setup();
    session.permissions.push({
      id: "per_1",
      sessionID: sessionId,
      action: "shell",
      resources: ["ls"],
    });
    session.permissions.push({
      id: "per_2",
      sessionID: sessionId,
      action: "shell",
      resources: ["rm x"],
    });
    const [first, second] = (await provider.interactions.listPendingInteractions(sessionId))
      .requests;
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          first!.id,
          resolution(sessionId, first!.id, "approve-for-session"),
        )
      ).result,
    ).toBe("rejected");
    expect(server.calls.some((call) => call.path.endsWith("/reply"))).toBe(false);
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          first!.id,
          resolution(sessionId, first!.id, "answer", []),
        )
      ).result,
    ).toBe("applied");
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          second!.id,
          resolution(sessionId, second!.id, "deny"),
        )
      ).result,
    ).toBe("applied");
    expect(session.replies).toEqual([
      { kind: "permission", id: "per_1", decision: "once" },
      { kind: "permission", id: "per_2", decision: "reject" },
    ]);
    expect(
      server.calls.filter((call) => call.path.endsWith("/reply")).map((call) => call.body),
    ).toEqual([{ decision: "once" }, { decision: "reject" }]);
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          first!.id,
          resolution(sessionId, first!.id, "deny"),
        )
      ).result,
    ).toBe("stale");
  });

  test("an edit permission shows its diff and offers a file rule; a shell one a command rule", async () => {
    const { provider, sessionId, session } = await setup();
    session.permissions.push({
      id: "per_e",
      sessionID: sessionId,
      action: "edit",
      resources: ["src/a.ts"],
      metadata: {
        files: [{ file: "src/a.ts", patch: "@@ -1 +1 @@\n-a\n+b", additions: 1, deletions: 1 }],
      },
    });
    session.permissions.push({
      id: "per_s",
      sessionID: sessionId,
      action: "shell",
      resources: ["bun test"],
    });
    session.permissions.push({
      id: "per_m",
      sessionID: sessionId,
      action: "shell",
      resources: ["a", "b"],
    });
    const requests = (await provider.interactions.listPendingInteractions(sessionId)).requests;
    expect(requests[0]!.presentation.body).toContain("File: src/a.ts");
    expect(requests[0]!.presentation.body).toContain("+b");
    expect(provider.interactions.permissionRuleDetail(sessionId, requests[0]!.id)).toEqual({
      subject: { kind: "file-change", paths: ["/work/src/a.ts"] },
      allowOnceAnswers: [],
    });
    expect(provider.interactions.permissionRuleDetail(sessionId, requests[1]!.id)).toEqual({
      subject: { kind: "command", command: "bun test" },
      allowOnceAnswers: [],
    });
    // Two commands in one call are not one exact command a rule may answer.
    expect(provider.interactions.permissionRuleDetail(sessionId, requests[2]!.id)).toBeNull();
    expect(provider.interactions.permissionRuleDetail("ses_other", requests[1]!.id)).toBeNull();
  });

  test("a form round-trips as a question card; decline cancels it", async () => {
    const { server, provider, sessionId, session } = await setup();
    session.forms.push({
      id: "frm_1",
      sessionID: sessionId,
      title: "Questions",
      metadata: { kind: "question" },
      fields: [
        {
          key: "q0",
          title: "Colour",
          description: "Pick one",
          type: "string",
          options: [{ value: "Red", label: "Red" }],
          custom: true,
        },
      ],
    });
    session.forms.push({
      id: "frm_2",
      sessionID: sessionId,
      title: "Other",
      fields: [{ key: "x", type: "string", title: "X" }],
    });
    const [question, other] = (await provider.interactions.listPendingInteractions(sessionId))
      .requests;
    expect(question).toMatchObject({
      kind: "question",
      presentation: { title: "OpenCode needs input", declineLabel: "Decline" },
    });
    expect(question!.presentation.questions[0]).toMatchObject({
      prompt: "Pick one",
      description: "Colour",
    });
    const answered = await provider.interactions.resolveInteraction(
      sessionId,
      question!.id,
      resolution(sessionId, question!.id, "answer", [{ questionId: "f0", optionIds: ["q0:o0"] }]),
    );
    expect(answered.result).toBe("applied");
    expect(session.replies[0]).toEqual({ kind: "form", id: "frm_1", answer: { q0: "Red" } });
    const declined = await provider.interactions.resolveInteraction(
      sessionId,
      other!.id,
      resolution(sessionId, other!.id, "decline"),
    );
    expect(declined.result).toBe("applied");
    expect(session.replies[1]).toEqual({ kind: "form", id: "frm_2", decision: "rejected" });
    expect(
      server.calls.filter((call) => call.method === "DELETE").map((call) => call.path),
    ).toEqual([`/api/session/${sessionId}/form/frm_2`]);
  });

  test("an answer the server refuses leaves the card pending; a malformed one is never sent", async () => {
    const { server, provider, sessionId, session } = await setup();
    session.forms.push({
      id: "frm_n",
      sessionID: sessionId,
      title: "Numbers",
      fields: [{ key: "n", type: "integer", title: "N", required: true }],
    });
    const [card] = (await provider.interactions.listPendingInteractions(sessionId)).requests;
    const before = server.calls.length;
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          card!.id,
          resolution(sessionId, card!.id, "answer", [{ questionId: "f0", freeText: "two" }]),
        )
      ).result,
    ).toBe("rejected");
    expect(server.calls.slice(before).some((call) => call.path.endsWith("/reply"))).toBe(false);
    server.failNextFormReply = {
      status: 400,
      body: { _tag: "Form.InvalidAnswerError", message: "bad" },
    };
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          card!.id,
          resolution(sessionId, card!.id, "answer", [{ questionId: "f0", freeText: "2" }]),
        )
      ).result,
    ).toBe("rejected");
    expect((await provider.interactions.listPendingInteractions(sessionId)).requests).toHaveLength(
      1,
    );
    // A card whose request vanished under it (answered elsewhere) is reported as such.
    session.forms = [];
    expect(
      (
        await provider.interactions.resolveInteraction(
          sessionId,
          card!.id,
          resolution(sessionId, card!.id, "answer", [{ questionId: "f0", freeText: "2" }]),
        )
      ).result,
    ).toBe("stale");
  });

  test("stopping the turn rejects every parked request", async () => {
    const { provider, sessionId, session } = await setup();
    session.permissions.push({
      id: "per_1",
      sessionID: sessionId,
      action: "shell",
      resources: ["ls"],
    });
    session.forms.push({
      id: "frm_1",
      sessionID: sessionId,
      title: "Q",
      fields: [{ key: "a", type: "string" }],
    });
    await provider.abort(sessionId);
    expect(session.replies).toEqual([
      { kind: "permission", id: "per_1", decision: "reject" },
      { kind: "form", id: "frm_1", decision: "rejected" },
    ]);
    expect((await provider.interactions.listPendingInteractions(sessionId)).requests).toEqual([]);
  });

  test("a session the server no longer has lists nothing", async () => {
    const { provider } = await setup();
    expect((await provider.interactions.listPendingInteractions("ses_gone")).requests).toEqual([]);
  });
});
