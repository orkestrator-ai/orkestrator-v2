import { describe, expect, test } from "bun:test";
import { type AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import {
  httpProvider,
  piConnection,
  declineResolution,
  answerResolution,
} from "./agent-provider-test-support.js";

describe("Pi interaction adapter", () => {
  test("Pi approvals map through the Codex shapes and answer with a decision", async () => {
    const requestedAt = Date.now();
    const expiresAt = requestedAt + 60_000;
    const hold = { available: true };
    // What `publicApprovals` in `bridges/pi-bridge/src/interactions.ts` serves.
    let approvals: Array<Record<string, unknown>> = [
      {
        approvalId: "pi-command",
        requestedAt,
        expiresAt,
        hold,
        reason: "Pi requested to run the bash tool.",
        kind: "command",
        command: "make release",
        cwd: "/workspace",
      },
      {
        approvalId: "pi-edit",
        requestedAt,
        expiresAt,
        hold,
        reason: "Pi requested to run the edit tool.",
        kind: "file-change",
        changes: [{ path: "src/a.ts", kind: "update" }],
      },
      {
        approvalId: "pi-write-no-path",
        requestedAt,
        expiresAt,
        hold,
        reason: "Pi requested to run the write tool.",
        kind: "file-change",
        changes: [],
        actionable: false,
      },
    ];
    const writes: Array<{ url: string; body: unknown }> = [];
    const { provider } = httpProvider((url, init) => {
      if (url.endsWith("/approvals")) return Response.json({ approvals, revision: 1 });
      if (url.endsWith("/interactions")) return Response.json({ interactions: [], revision: 1 });
      writes.push({ url, body: JSON.parse(String(init.body)) });
      approvals = approvals.filter((entry) => !url.endsWith(`/${String(entry.approvalId)}`));
      return Response.json({ resolved: true });
    }, piConnection);

    const { requests } = await provider.interactions!.listPendingInteractions("session-1");
    expect(requests.map(({ kind }) => kind)).toEqual([
      "command-approval",
      "file-approval",
      "file-approval",
    ]);
    const [command, edit, pathless] = requests as [
      AgentInteractionRequest,
      AgentInteractionRequest,
      AgentInteractionRequest,
    ];
    expect(command.presentation).toMatchObject({
      title: "Approve command",
      body: "Reason: Pi requested to run the bash tool.\nCommand: make release\nWorking directory: /workspace",
      confirmDisabled: false,
    });
    expect(edit.presentation).toMatchObject({
      title: "Approve file changes",
      body: "Reason: Pi requested to run the edit tool.\nChange: update: src/a.ts",
      confirmDisabled: false,
    });
    // Pi has no session-wide grant, so none is offered.
    expect(edit.presentation.approveForSessionLabel).toBeUndefined();
    expect(pathless.presentation.confirmDisabled).toBe(true);

    // A change nobody can name, and a session grant Pi cannot honour, are
    // refused before anything reaches the bridge.
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        pathless.id,
        answerResolution(pathless),
      ),
    ).resolves.toMatchObject({ result: "rejected" });
    await expect(
      provider.interactions!.resolveInteraction("session-1", edit.id, {
        ...answerResolution(edit),
        action: "approve-for-session",
        answer: undefined,
      }),
    ).resolves.toMatchObject({ result: "rejected" });
    expect(writes).toEqual([]);

    await expect(
      provider.interactions!.resolveInteraction("session-1", edit.id, answerResolution(edit)),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        command.id,
        declineResolution(command),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    await expect(
      provider.interactions!.resolveInteraction(
        "session-1",
        pathless.id,
        declineResolution(pathless),
      ),
    ).resolves.toMatchObject({ result: "applied" });
    // The Pi bridge allows only an explicit `approve`; anything else denies.
    expect(writes).toEqual([
      { url: expect.stringContaining("/approvals/pi-edit"), body: { decision: "approve" } },
      { url: expect.stringContaining("/approvals/pi-command"), body: { decision: "deny" } },
      {
        url: expect.stringContaining("/approvals/pi-write-no-path"),
        body: { decision: "deny" },
      },
    ]);
  });
});
