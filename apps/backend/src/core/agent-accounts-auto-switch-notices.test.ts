import { describe, expect, mock, test } from "bun:test";
import { AGENT_ACCOUNT_AUTO_SWITCHED_EVENT } from "@orkestrator/protocol/agent-account-auto-switch";
import {
  bridgeRemoteAutoSwitchNotices,
  mailAutoSwitchNotice,
} from "./agent-accounts-auto-switch-notices.js";

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

  test("carries the two accounts as facts and rides along instead of waking the coordinator", async () => {
    const send = mock(async () => ({}));
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "mini");
    const [, , options] = send.mock.calls[0] as unknown as [
      unknown,
      unknown,
      { notice: unknown; rideAlong: boolean },
    ];
    expect(options.rideAlong).toBe(true);
    expect(options.notice).toEqual({
      resource: { kind: "account-switch", id: "codex", label: "mini" },
      accountSwitch: { provider: "Codex", from: "a@example.com", to: "b@example.com" },
      state: "account-switched",
      tone: "info",
    });
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

describe("who the notice skips", () => {
  test("the coordinator a move was made for, whose own notice says so", async () => {
    const send = mock(async () => ({}));
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "this machine", {
      quietProjectId: "project-1",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).not.toContain('"main-tab"');
  });

  test("coordinators whose repository the command node hears about instead", async () => {
    const send = mock(async () => ({}));
    await mailAutoSwitchNotice(storageWith(send), NOTICE, "this machine", {
      hearsHere: async (projectId) => projectId === "project-2",
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(send.mock.calls)).toContain('"main-tab-2"');
  });

  test("a sender that must retry is told a delivery failed", async () => {
    const send = mock(async () => {
      throw new Error("mail is off");
    });
    await expect(
      mailAutoSwitchNotice(storageWith(send), NOTICE, "leaf", { requireDelivery: true }),
    ).rejects.toThrow("mail is off");
  });
});

describe("a switch on a machine this one controls", () => {
  function bridge() {
    let listener: ((event: string, payload: unknown, nodeId: string) => void) | undefined;
    const mailed: Array<[unknown, string]> = [];
    bridgeRemoteAutoSwitchNotices({
      onNodeEvent: (next) => {
        listener = next;
        return () => undefined;
      },
      nodeName: async (nodeId) => {
        if (nodeId === "gone") throw new Error("not connected");
        return "Leaf one";
      },
      mail: async (event, machineName) => {
        mailed.push([event, machineName]);
      },
    });
    return { emit: listener!, mailed };
  }

  test("a machine that sends through its outbox is not told about twice", async () => {
    let listener: ((event: string, payload: unknown, nodeId: string) => void) | undefined;
    const mailed: unknown[] = [];
    bridgeRemoteAutoSwitchNotices({
      onNodeEvent: (next) => {
        listener = next;
        return () => undefined;
      },
      nodeName: async () => "Leaf one",
      mail: async (event) => {
        mailed.push(event);
      },
      sendsThroughOutbox: (nodeId) => nodeId === "new-leaf",
    });
    listener!(AGENT_ACCOUNT_AUTO_SWITCHED_EVENT, NOTICE, "new-leaf");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mailed).toHaveLength(0);
    listener!(AGENT_ACCOUNT_AUTO_SWITCHED_EVENT, NOTICE, "older-leaf");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mailed).toHaveLength(1);
  });

  test("reaches this node's coordinators, naming the machine", async () => {
    const { emit, mailed } = bridge();
    emit(AGENT_ACCOUNT_AUTO_SWITCHED_EVENT, NOTICE, "leaf-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mailed).toEqual([[NOTICE, "Leaf one"]]);
  });

  test("still goes out when the machine's name cannot be read", async () => {
    const { emit, mailed } = bridge();
    emit(AGENT_ACCOUNT_AUTO_SWITCHED_EVENT, NOTICE, "gone");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mailed).toEqual([[NOTICE, "gone"]]);
  });

  test("ignores other events and anything malformed", async () => {
    const { emit, mailed } = bridge();
    emit("node-outbox-ready", NOTICE, "leaf-1");
    emit(AGENT_ACCOUNT_AUTO_SWITCHED_EVENT, { platform: "grok" }, "leaf-1");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mailed).toEqual([]);
  });
});
