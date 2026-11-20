import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  AgentPendingInteractionSummary,
  AgentRegistryEntry,
  AgentRegistrySnapshot,
} from "@orkestrator/protocol/agent-registry";
import {
  EnvironmentAgentSummary,
  LOCAL_AGENT_SUMMARY_SOURCE,
  type AgentSummarySource,
} from "./EnvironmentAgentSummary";
import { dispatchResourceChange, RESOURCE_COALESCE_MS } from "@/lib/resource-sync";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
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
    expect(onOpen).toHaveBeenCalledWith("agent-tab", "agent-tab-request");
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

  test.each([
    ["array", []],
    ["empty object", {}],
    ["empty snapshot", snapshot([])],
    [
      "malformed entries",
      { entries: [null, entry("agent-tab", { detail: {} as string })], environments: [null, {}] },
    ],
    ["rejected read", undefined],
  ])("a %s reply keeps the waiting line and hover card safe", async (_label, result) => {
    const read = mock(async () => {
      if (result === undefined) throw new Error("unreachable");
      return result as AgentRegistrySnapshot;
    });
    const value: AgentSummarySource = { read, subscribe: () => () => {} };
    const onOpen = mock(() => {});
    render(
      <>
        <EnvironmentAttentionLine
          environmentId="env-1"
          attention={waiting}
          source={value}
          onOpen={onOpen}
        />
        <EnvironmentAgentSummary environmentId="env-1" open source={value} />
      </>,
    );
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/agent tabs?/) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: WAITING_GENERIC }));
    expect(onOpen).toHaveBeenCalledWith(null);
  });

  test("an older registry's MCP form title is kept out of its row", async () => {
    const { value } = source([
      entry("agent-tab", {
        kind: "mcp-form",
        label: "Untrusted provider title",
        detail: "Sensitive input",
      }),
    ]);
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={waiting}
        source={value}
        onOpen={() => {}}
      />,
    );
    const line = await screen.findByRole("button", { name: /^Needs input/ });
    expect(line.getAttribute("title")).not.toMatch(/Untrusted|Sensitive/);
  });

  test("a deadline fallback retries within the same wait and stops when the line closes", async () => {
    const time = installControlledTimeout(1_000, { label: "first pending retry" });
    try {
      let reads = 0;
      const value: AgentSummarySource = {
        read: async () =>
          snapshot([
            ++reads === 1
              ? entry("agent-tab", undefined, { state: "waiting" })
              : entry("agent-tab", {}),
          ]),
        subscribe: () => () => {},
      };
      const view = render(
        <EnvironmentAttentionLine
          environmentId="env-1"
          attention={waiting}
          source={value}
          onOpen={() => {}}
        />,
      );
      await act(async () => {});
      expect(screen.getByRole("button", { name: WAITING_GENERIC })).toBeTruthy();
      expect(time.pendingCount()).toBe(1);
      await act(async () => {
        time.advance();
      });
      expect(screen.getByRole("button", { name: WAITING_NAMED })).toBeTruthy();
      expect(reads).toBe(2);
      view.unmount();
    } finally {
      cleanup();
      time.restore();
    }
  });

  test("a native-session change replaces an answered request while the local row keeps waiting", async () => {
    const debounce = installControlledTimeout(250, { label: "registry refresh" });
    const resource = installControlledTimeout(RESOURCE_COALESCE_MS, {
      label: "resource coalescing",
    });
    try {
      let reads = 0;
      const value: AgentSummarySource = {
        ...LOCAL_AGENT_SUMMARY_SOURCE,
        read: async () =>
          snapshot([
            ++reads === 1
              ? entry("tab", { count: 2, detail: "First request" })
              : entry("tab", { interactionId: "next", detail: "Second request" }),
          ]),
      };
      const onOpen = mock(() => {});
      render(
        <EnvironmentAttentionLine
          environmentId="env-1"
          attention={waiting}
          source={value}
          onOpen={onOpen}
        />,
      );
      await act(async () => {});
      expect(screen.getByRole("button", { name: /First request.*2 waiting/ })).toBeTruthy();
      act(() =>
        dispatchResourceChange({
          resource: "native-agent-session",
          id: "env-1",
          revision: 1,
          cause: "pending-interactions",
        }),
      );
      await act(async () => {
        resource.advance();
        debounce.advance();
      });
      expect(screen.queryByRole("button", { name: /First request/ }) === null).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: /Second request/ }));
      expect(onOpen).toHaveBeenCalledWith("tab", "next");
    } finally {
      cleanup();
      resource.restore();
      debounce.restore();
    }
  });

  test("reads nothing for unread work, or while the machine is unreachable", () => {
    const { read, value } = source([entry("agent-tab", {})]);
    render(
      <EnvironmentAttentionLine
        environmentId="env-1"
        attention={{
          tone: "unread",
          text: "Ready for input · unread",
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
    expect(screen.getByRole("button", { name: "Ready for input · unread" })).toBeTruthy();
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
