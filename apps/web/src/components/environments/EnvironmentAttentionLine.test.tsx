import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentPendingInteractionSummary,
  AgentRegistryEntry,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import type { AgentSummarySource } from "./EnvironmentAgentSummary";
import { EnvironmentAttentionLine, pendingTarget } from "./EnvironmentAttentionLine";
import type { EnvironmentRowAttention } from "./environment-row-model";

afterEach(cleanup);

// The line's clock moves by whole minutes (`useMinuteClock`), so durations are
// matched by shape here; `environment-row-model.attention.test.ts` pins the words.
const WAITING_GENERIC = /^Waiting for you · \d+ min$/;
const WAITING_NAMED = /^Needs approval: Run bun install · \d+ min$/;

function entry(
  tabId: string,
  pending?: Partial<AgentPendingInteractionSummary>,
  overrides: Partial<AgentRegistryEntry> = {},
): AgentRegistryEntry {
  return {
    projectId: "p1",
    environmentId: "env-1",
    environmentName: "feature",
    tabId,
    ownerKind: "environment",
    kind: "native",
    agent: "claude",
    displayName: tabId,
    tabOrdinal: 1,
    state: pending ? "waiting" : "idle",
    ...(pending
      ? {
          pending: {
            interactionId: `${tabId}-request`,
            kind: "command-approval",
            label: "Needs approval",
            detail: "Run bun install",
            since: Date.now() - 5 * 60_000,
            count: 1,
            ...pending,
          },
        }
      : {}),
    ...overrides,
  };
}

function snapshot(entries: AgentRegistryEntry[]): AgentRegistrySnapshot {
  return { generatedAt: new Date(0).toISOString(), entries, environments: [] };
}

function source(entries: AgentRegistryEntry[]) {
  const read = mock(async (_environmentId: string, _options?: { includePending?: boolean }) =>
    snapshot(entries),
  );
  const value: AgentSummarySource = { read, subscribe: () => () => {} };
  return { read, value };
}

const waiting: EnvironmentRowAttention = {
  tone: "waiting",
  text: "Waiting for you",
  since: new Date(Date.now() - 8 * 60_000).toISOString(),
  readsPending: true,
};

describe("EnvironmentAttentionLine", () => {
  test("names the request a waiting agent waits on and opens its tab", async () => {
    const { read, value } = source([entry("idle-tab"), entry("agent-tab", {})]);
    const onOpen = mock((_tabId: string | null) => {});
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={waiting}
        source={value}
        onOpen={onOpen}
      />,
    );
    // The generic wording shows until the machine answers.
    expect(screen.getByRole("button", { name: WAITING_GENERIC })).toBeTruthy();
    const line = await screen.findByRole("button", { name: WAITING_NAMED });
    expect(read).toHaveBeenCalledWith("env-1", { includePending: true });
    fireEvent.click(line);
    expect(onOpen).toHaveBeenCalledWith("agent-tab");
  });

  test("keeps its generic wording and opens the environment when no request is known", async () => {
    const { read, value } = source([entry("agent-tab")]);
    const onOpen = mock((_tabId: string | null) => {});
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={waiting}
        source={value}
        onOpen={onOpen}
      />,
    );
    await waitFor(() => expect(read).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: WAITING_GENERIC }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  test("reads nothing for unread work, or while the machine is unreachable", () => {
    const { read, value } = source([entry("agent-tab", {})]);
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={{
          tone: "unread",
          text: "Finished · result unread",
          since: null,
          readsPending: false,
        }}
        source={value}
        onOpen={() => {}}
      />,
    );
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={waiting}
        source={null}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Finished · result unread" })).toBeTruthy();
    expect(screen.getByRole("button", { name: WAITING_GENERIC })).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("pendingTarget", () => {
  test("the longest-waiting request across tabs, counting every pending one", () => {
    const now = Date.now();
    const target = pendingTarget(
      snapshot([
        entry("newer", { since: now - 1_000, count: 2 }),
        entry("older", { since: now - 9_000 }),
        // A coordinator conversation and another environment are not this row's.
        entry("coordinator", { since: now - 99_000 }, { ownerKind: "coordinator" }),
        entry("elsewhere", { since: now - 99_000 }, { environmentId: "env-2" }),
      ]),
      "env-1",
    );
    expect(target).toMatchObject({ tabId: "older", total: 3 });
    expect(pendingTarget(snapshot([entry("idle")]), "env-1")).toBeNull();
    expect(pendingTarget(null, "env-1")).toBeNull();
  });
});
