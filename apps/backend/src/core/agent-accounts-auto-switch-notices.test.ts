import { describe, expect, mock, test } from "bun:test";
import { mailAutoSwitchNotice } from "./agent-accounts-auto-switch-notices.js";

const NOTICE = {
  platform: "codex" as const,
  from: "a@example.com",
  to: "b@example.com",
  reason: "limit" as const,
  at: "2026-11-01T12:00:00.000Z",
};

function storageWith(sendAgentMail: (...args: unknown[]) => Promise<unknown>) {
  return {
    sendAgentMail,
    coordinators: {
      getCoordinatorReconciliationState: async () => ({
        workflows: [],
        workspaces: [
          {
            id: "coordinator-1",
            projectId: "project-1",
            lifecycleState: "ready",
            conversations: [
              { id: "main-1", tabId: "main-tab", role: "main" },
              { id: "side-1", tabId: "side-tab", role: "side" },
            ],
          },
          {
            id: "coordinator-2",
            projectId: "project-2",
            lifecycleState: "ready",
            conversations: [{ id: "main-2", tabId: "main-tab-2", role: "main" }],
          },
        ],
      }),
    },
  } as never;
}

describe("the notice of an automatic switch", () => {
  test("reaches each main coordinator, and no side agent", async () => {
    const send = mock(async () => ({}));
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "this machine");
    expect(send).toHaveBeenCalledTimes(2);
    const [sender, message] = send.mock.calls[0] as unknown as [
      Record<string, unknown>,
      Record<string, string>,
    ];
    expect(sender).toMatchObject({ kind: "system", projectId: "project-1", source: "workflow" });
    expect(message.toTabId).toBe("main-tab");
    expect(message.subject).toContain("b@example.com");
    expect(message.body).toContain("a@example.com");
    expect(message.body).toContain("confirmed");
    expect(JSON.stringify(send.mock.calls)).not.toContain("side-tab");
  });

  test("one coordinator refusing mail does not stop the others hearing", async () => {
    const send = mock(async (_sender: unknown, message: unknown) => {
      if ((message as { toTabId: string }).toTabId === "main-tab") throw new Error("mail is off");
      return {};
    });
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "this machine");
    expect(send).toHaveBeenCalledTimes(2);
  });

  test("the same switch reaches a coordinator under one request id, so a retry cannot repeat it", async () => {
    const send = mock(async () => ({}));
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "leaf");
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "leaf");
    const ids = (send.mock.calls as unknown as Array<[unknown, { requestId: string }]>).map(
      ([, message]) => message.requestId,
    );
    expect(ids[0]).toBe(ids[2]);
    expect(ids[1]).toBe(ids[3]);
  });
});
