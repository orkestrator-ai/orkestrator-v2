import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import type { AgentMailMailboxSnapshot } from "@orkestrator/protocol/agent-mail";
import { agentMailStore } from "@/stores/agentMailStore";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { agentMailStatus, useAgentMailEnvironmentName } from "./agent-mail-ui";
import { appCommandStore } from "@/test/app-command-store";

describe("agentMailStatus", () => {
  const stored = { placement: "stored" as const, placementReason: "recipient-cannot-inject" };

  test("says stored mail is waiting when its recipient has no agent to read it", () => {
    expect(agentMailStatus(stored, { canPull: false })).toEqual({
      label: "waiting for agent",
      tone: "warning",
    });
  });

  test("keeps 'in inbox' for a recipient that can pull, or an unknown one", () => {
    expect(agentMailStatus(stored, { canPull: true }).label).toBe("in inbox");
    expect(agentMailStatus(stored).label).toBe("in inbox");
    expect(agentMailStatus({ ...stored, ackedAt: "now" }, { canPull: false }).label).toBe(
      "handled",
    );
  });
});

describe("useAgentMailEnvironmentName", () => {
  const initialMail = appCommandStore(agentMailStore).getState();
  const initialEnvironments = appCommandStore(environmentStore).getState();

  beforeEach(() => {
    appCommandStore(agentMailStore).setState({ mailboxes: new Map() });
    appCommandStore(environmentStore).setState({ environments: [] });
  });

  afterEach(() => {
    cleanup();
    appCommandStore(agentMailStore).setState(initialMail, true);
    appCommandStore(environmentStore).setState(initialEnvironments, true);
  });

  test("falls back to a loaded mailbox and prefers the live environment name", () => {
    const mailbox: AgentMailMailboxSnapshot = {
      descriptor: {
        mailboxId: "env-1\0tab-1",
        incarnationId: "i",
        projectId: "p",
        projectName: "Project",
        environmentId: "env-1",
        environmentName: "Mailbox name",
        environmentStatus: "running",
        tabId: "tab-1",
        tabType: "agent-native",
        title: "Claude 1",
        displayName: "Claude 1",
        tabOrdinal: 1,
        agent: "claude",
        kind: "native",
        presence: "idle",
        injectPolicy: "off",
        injectOverride: "inherit",
        mutedInbound: false,
        mutedOutbound: false,
        unreadCount: 0,
        userUnseenCount: 0,
        agentUnackedCount: 0,
        pendingInjectCount: 0,
        failedInjectCount: 0,
        capabilities: { canPull: true, canSend: true, canInject: true },
      },
      messages: [],
      total: 0,
      offset: 0,
      limit: 100,
      revision: 1,
    };
    const { result, rerender } = renderHookInAppCommandScope(
      ({ id }: { id: string | undefined }) => useAgentMailEnvironmentName(id),
      { initialProps: { id: "env-1" as string | undefined } },
    );
    expect(result.current).toBeUndefined();
    act(() => appCommandStore(agentMailStore).getState().setMailbox(mailbox));
    expect(result.current).toBe("Mailbox name");
    act(() =>
      appCommandStore(environmentStore).setState({
        environments: [{ id: "env-1", name: "Current name", order: 0 } as Environment],
      }),
    );
    expect(result.current).toBe("Current name");
    act(() => appCommandStore(environmentStore).setState({ environments: [] }));
    expect(result.current).toBe("Mailbox name");
    rerender({ id: "missing" });
    expect(result.current).toBeUndefined();
    rerender({ id: undefined });
    expect(result.current).toBeUndefined();
  });
});
