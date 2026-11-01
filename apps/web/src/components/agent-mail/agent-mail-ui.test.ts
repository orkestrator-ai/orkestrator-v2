import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { AgentMailMailboxSnapshot } from "@orkestrator/protocol/agent-mail";
import { useAgentMailStore } from "@/stores/agentMailStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import {
  agentMailParticipantLabel,
  agentMailStatus,
  useAgentMailEnvironmentName,
} from "./agent-mail-ui";

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

describe("agentMailParticipantLabel", () => {
  test.each([
    ["worker on omarchy-hp", undefined, "worker on omarchy-hp"],
    ["Claude 2 on omarchy-hp", "worker", "worker · Claude 2 on omarchy-hp"],
  ])("formats a node participant named %s", (displayName, environmentName, expected) => {
    // Older leaves use the environment as their title. The backend omits the
    // redundant environmentName before adding the node suffix to displayName.
    expect(agentMailParticipantLabel({ kind: "agent", displayName, environmentName })).toBe(
      expected,
    );
  });

  test("names an agent by its environment and tab, and anyone else by its own name", () => {
    expect(
      agentMailParticipantLabel({
        kind: "agent",
        displayName: "Claude 2",
        environmentName: "fix-login-bug",
      }),
    ).toBe("fix-login-bug · Claude 2");
    // A closed tab whose environment is gone keeps the name its messages carried.
    expect(agentMailParticipantLabel({ kind: "agent", displayName: "Claude 2" })).toBe("Claude 2");
    // The coordinator's mailbox lives in a "Coordinator" environment; it stays a coordinator.
    expect(
      agentMailParticipantLabel({
        kind: "coordinator",
        displayName: "Project coordinator",
        environmentName: "Coordinator",
      }),
    ).toBe("Project coordinator");
    expect(agentMailParticipantLabel({ kind: "user", displayName: "You" })).toBe("You");
  });
});

describe("useAgentMailEnvironmentName", () => {
  const initialMail = useAgentMailStore.getState();
  const initialEnvironments = useEnvironmentStore.getState();

  beforeEach(() => {
    useAgentMailStore.setState({ mailboxes: new Map() });
    useEnvironmentStore.setState({ environments: [] });
  });

  afterEach(() => {
    cleanup();
    useAgentMailStore.setState(initialMail, true);
    useEnvironmentStore.setState(initialEnvironments, true);
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
    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useAgentMailEnvironmentName(id),
      { initialProps: { id: "env-1" as string | undefined } },
    );
    expect(result.current).toBeUndefined();
    act(() => useAgentMailStore.getState().setMailbox(mailbox));
    expect(result.current).toBe("Mailbox name");
    act(() =>
      useEnvironmentStore.setState({
        environments: [{ id: "env-1", name: "Current name", order: 0 } as Environment],
      }),
    );
    expect(result.current).toBe("Current name");
    act(() => useEnvironmentStore.setState({ environments: [] }));
    expect(result.current).toBe("Mailbox name");
    rerender({ id: "missing" });
    expect(result.current).toBeUndefined();
    rerender({ id: undefined });
    expect(result.current).toBeUndefined();
  });
});
