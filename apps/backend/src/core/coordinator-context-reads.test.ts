import { describe, expect, mock, spyOn, test } from "bun:test";
import type { CoordinatorWorkflowAssociation } from "@orkestrator/protocol/coordinator";
import {
  agentMessagingEnabled,
  coordinatorDelegationAvailable,
  readCoordinatorWaitingOn,
} from "./coordinator-context-reads.js";

import * as providers from "./coordinator-providers.js";

const config = (agentMessaging?: { enabled: boolean }) => ({
  loadConfig: async () => ({ global: { agentMessaging } }) as never,
});

function open(id: string, overrides: Partial<CoordinatorWorkflowAssociation> = {}) {
  return {
    id,
    coordinatorId: "coordinator-1",
    projectId: "project-1",
    kind: "environment",
    resourceId: id,
    requestId: `request-${id}`,
    createdAt: new Date(0).toISOString(),
    delegation: {
      requestedAt: new Date(0).toISOString(),
      workerTabId: "tab-1",
      state: "running",
    },
    ...overrides,
  } as CoordinatorWorkflowAssociation;
}

function storageWith(
  associations: CoordinatorWorkflowAssociation[],
  names: Record<string, string> = {},
) {
  const getEnvironment = mock(async (id: string) =>
    names[id] ? ({ id, name: names[id] } as never) : null,
  );
  return {
    getEnvironment,
    coordinators: { listOpenCoordinatorDelegations: async () => associations },
  };
}

describe("agentMessagingEnabled", () => {
  test("only an explicit on counts, as for every other reader of the setting", async () => {
    expect(await agentMessagingEnabled(config({ enabled: true }))).toBe(true);
    expect(await agentMessagingEnabled(config({ enabled: false }))).toBe(false);
    expect(await agentMessagingEnabled(config())).toBe(false);
  });
});

describe("coordinatorDelegationAvailable", () => {
  const available = (running: boolean, enabled: boolean, platform: "codex" | "claude" = "codex") =>
    coordinatorDelegationAvailable(platform, {
      controlMcpRunning: () => running,
      storage: config({ enabled }),
    });

  test("needs Control MCP, a qualified platform and agent messaging", async () => {
    expect(await available(true, true)).toBe(true);
    expect(await available(false, true)).toBe(false);
    // With messaging off every delegation would wait for a wake that cannot arrive.
    expect(await available(true, false)).toBe(false);
  });

  test("an unqualified provider cannot delegate even with messaging and controls on", async () => {
    const qualification = spyOn(providers, "coordinatorProviderQualification").mockReturnValue({
      tier: "unavailable",
      available: false,
      delegation: false,
    });
    const loadConfig = mock(
      async () => ({ global: { agentMessaging: { enabled: true } } }) as never,
    );
    try {
      expect(
        await coordinatorDelegationAvailable("codex", {
          controlMcpRunning: () => true,
          storage: { loadConfig },
        }),
      ).toBe(false);
      expect(qualification).toHaveBeenCalledWith("codex");
      expect(loadConfig).not.toHaveBeenCalled();
    } finally {
      qualification.mockRestore();
    }
  });

  test("does not read the setting when Control MCP already answers", async () => {
    const loadConfig = mock(async () => ({ global: {} }) as never);
    await coordinatorDelegationAvailable("codex", {
      controlMcpRunning: () => false,
      storage: { loadConfig },
    });
    expect(loadConfig).not.toHaveBeenCalled();
  });
});

describe("readCoordinatorWaitingOn", () => {
  test("is null when this coordinator has nothing open", async () => {
    expect(await readCoordinatorWaitingOn(storageWith([]), "coordinator-1")).toBeNull();
    expect(
      await readCoordinatorWaitingOn(
        storageWith([open("a", { coordinatorId: "coordinator-2" })]),
        "coordinator-1",
      ),
    ).toBeNull();
  });

  test("reads one environment per spelled-out name, however many are open", async () => {
    const storage = storageWith(
      ["a", "b", "c", "d", "e"].map((id) => open(id)),
      { a: "Alpha", b: "Beta", c: "Gamma", d: "Delta", e: "Epsilon" },
    );
    const waiting = await readCoordinatorWaitingOn(storage, "coordinator-1");
    expect(waiting?.total).toBe(5);
    expect(waiting?.names).toHaveLength(3);
    expect(storage.getEnvironment).toHaveBeenCalledTimes(3);
  });

  test("names a worker from its environment, then its record, then its id", async () => {
    const storage = storageWith(
      [
        open("named", { delegation: { ...open("x").delegation!, requestedAt: "2026-01-03" } }),
        open("recorded", {
          delegation: { ...open("x").delegation!, requestedAt: "2026-01-02" },
          workerOutcome: { name: "Recorded" } as CoordinatorWorkflowAssociation["workerOutcome"],
        }),
        open("bare", { delegation: { ...open("x").delegation!, requestedAt: "2026-01-01" } }),
      ],
      { named: "Named" },
    );
    expect(await readCoordinatorWaitingOn(storage, "coordinator-1")).toEqual({
      names: ["Named", "Recorded", "bare"],
      total: 3,
    });
  });

  test("a worker on another node is not read here", async () => {
    const storage = storageWith([open("remote", { nodeId: "node-1" })], { remote: "Wrong" });
    expect(await readCoordinatorWaitingOn(storage, "coordinator-1")).toEqual({
      names: ["remote"],
      total: 1,
    });
    expect(storage.getEnvironment).not.toHaveBeenCalled();
  });

  test("a failed read costs a name or the line, never the turn", async () => {
    const failingName = storageWith([open("a")]);
    failingName.getEnvironment.mockImplementation(async () => {
      throw new Error("unreadable");
    });
    expect(await readCoordinatorWaitingOn(failingName, "coordinator-1")).toEqual({
      names: ["a"],
      total: 1,
    });
    expect(
      await readCoordinatorWaitingOn(
        {
          getEnvironment: async () => null,
          coordinators: {
            listOpenCoordinatorDelegations: async () => {
              throw new Error("unreadable");
            },
          },
        },
        "coordinator-1",
      ),
    ).toBeNull();
  });
});
