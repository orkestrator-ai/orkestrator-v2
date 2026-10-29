import { describe, expect, test } from "bun:test";
import { type AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import {
  grokConnection,
  httpProvider,
  declineResolution,
  answerResolution,
} from "./agent-provider-test-support.js";

describe("Grok interaction adapter", () => {
  test("Grok discloses bridge-truncated approval details and refuses positive answers", async () => {
    let approvals = [
      {
        id: "long-command",
        title: "Run command",
        kind: "command",
        command: "x".repeat(4096),
        commandTruncated: true,
      },
      {
        id: "many-files",
        title: "Edit files",
        kind: "file-change",
        paths: Array.from({ length: 20 }, (_, i) => `/w/${i}`),
        pathsOmitted: 5,
      },
    ].map((entry) => ({
      ...entry,
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    }));
    const upstream: string[] = [];
    const { provider } = httpProvider((url) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      upstream.push(url);
      approvals = approvals.filter((entry) => !url.endsWith(`/${entry.id}`));
      return Response.json({ status: "applied" });
    }, grokConnection);
    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests.map((r) => r.kind)).toEqual(["command-approval", "file-approval"]);
    expect(requests[0]!.presentation.body).toContain("Command details were truncated");
    expect(requests[1]!.presentation.body).toContain("5 additional file paths were omitted");
    for (const request of requests) {
      expect(request.presentation.confirmDisabled).toBe(true);
      expect(
        await provider.interactions!.resolveInteraction(
          "session-1",
          request.id,
          answerResolution(request),
        ),
      ).toMatchObject({ result: "rejected" });
    }
    expect(upstream).toEqual([]);
    expect(
      await provider.interactions!.resolveInteraction(
        "session-1",
        requests[0]!.id,
        declineResolution(requests[0]!),
      ),
    ).toMatchObject({ result: "applied" });
    expect(upstream).toHaveLength(1);
  });

  test("normalizes Grok plan and question requests and maps their exact outcomes", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    let interactions: Array<Record<string, unknown>> = [
      {
        id: "plan-call",
        kind: "plan-approval",
        plan: "# Plan\n\nShip the adapter.",
        planTruncated: false,
        requestedAt,
        expiresAt,
      },
      {
        id: "question-call",
        kind: "question",
        requestedAt,
        expiresAt,
        questions: [
          {
            id: "language",
            question: "Which language?",
            multiple: false,
            options: [{ id: "typescript", label: "TypeScript" }],
          },
        ],
      },
    ];
    const writes: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider(async (url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals: [] });
      if (url.endsWith("/interactions")) return Response.json({ interactions });
      if (url.includes("/interactions/")) {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        const id = decodeURIComponent(url.split("/").at(-1)!);
        interactions = interactions.filter((entry) => entry.id !== id);
        return Response.json({ resolved: true });
      }
      return Response.json({ status: "idle" });
    }, grokConnection);

    const snapshot = await provider.interactions!.listPendingInteractions("session-1");
    expect(snapshot.requests.map(({ kind }) => kind)).toEqual(["plan-approval", "question"]);
    const plan = snapshot.requests[0]!;
    const question = snapshot.requests[1]!;
    await expect(
      provider.interactions!.resolveInteraction("session-1", plan.id, {
        ...declineResolution(plan),
        feedback: "Add rollback steps",
      }),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        question.id,
        answerResolution(question),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    expect(writes.map(({ body }) => body)).toEqual([
      { action: "revise", feedback: "Add rollback steps" },
      { action: "accept", answers: { language: ["typescript"] } },
    ]);
  });

  test("Grok maps a call without command or file detail to a generic permission", async () => {
    let approvals: Array<Record<string, unknown>> = [
      "fetch-allow",
      "fetch-deny",
      "fetch-cancel",
    ].map((id) => ({
      id,
      title: "Fetch a page",
      kind: "permission",
      requestedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    }));
    const writes: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [] });
      writes.push({ url, body: JSON.parse(String(init.body)) });
      approvals = approvals.filter((entry) => !url.endsWith(`/${String(entry.id)}`));
      return Response.json({ resolved: true });
    }, grokConnection);

    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests.map(({ kind }) => kind)).toEqual(["permission", "permission", "permission"]);
    const [allow, deny, cancel] = requests as [
      AgentInteractionRequest,
      AgentInteractionRequest,
      AgentInteractionRequest,
    ];
    expect(allow.presentation).toMatchObject({
      title: "Fetch a page",
      confirmLabel: "Continue",
      declineLabel: "Deny",
      confirmDisabled: false,
    });
    // Nothing to show beyond the title: no command or file lines.
    expect(allow.presentation.body).toBeUndefined();
    expect(allow.presentation.questions[0]!.options.map((option) => option.label)).toEqual([
      "Allow once",
      "Reject",
    ]);

    // The bridge would read a session grant as a denial; it is refused here.
    await expect(
      provider.interactions!.resolveInteraction("session-1", allow.id, {
        ...answerResolution(allow),
        action: "approve-for-session",
        answer: undefined,
      }),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(writes).toEqual([]);

    for (const [request, resolution] of [
      [allow, answerResolution(allow)],
      [deny, declineResolution(deny)],
      [cancel, { ...declineResolution(cancel), action: "cancel" }],
    ] as const) {
      await expect(
        provider.interactions!.resolveInteraction("session-1", request.id, resolution),
      ).resolves.toMatchObject({ result: "applied" });
    }
    expect(writes).toEqual([
      { url: expect.stringContaining("/approvals/fetch-allow"), body: { optionId: "allow" } },
      { url: expect.stringContaining("/approvals/fetch-deny"), body: { decision: "deny" } },
      { url: expect.stringContaining("/approvals/fetch-cancel"), body: { decision: "cancel" } },
    ]);
  });
});
