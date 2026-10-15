import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import * as realBackend from "@/lib/backend";
import { dispatchResourceChange, resetResourceSync } from "@/lib/resource-sync";

let working = 1;
const getAgentRegistry = mock(async (): Promise<AgentRegistrySnapshot> => ({
  generatedAt: new Date(0).toISOString(),
  entries: [],
  environments: [
    {
      environmentId: "env-1",
      tabs: 3,
      working,
      waiting: 0,
      idle: 3 - working,
      stopped: 0,
      unknown: 0,
    },
  ],
}));

mock.module("@/lib/backend", () => ({ ...realBackend, getAgentRegistry }));

const { EnvironmentAgentSummary } = await import("./EnvironmentAgentSummary");

afterEach(() => {
  cleanup();
  resetResourceSync();
  getAgentRegistry.mockClear();
  working = 1;
});

afterAll(() => {
  mock.module("@/lib/backend", () => realBackend);
});

describe("EnvironmentAgentSummary", () => {
  test("reads nothing while the hover card is closed", () => {
    render(<EnvironmentAgentSummary environmentId="env-1" open={false} />);
    expect(getAgentRegistry).not.toHaveBeenCalled();
  });

  test("shows the counts and follows changes while open", async () => {
    render(<EnvironmentAgentSummary environmentId="env-1" open />);
    expect(await screen.findByText("3 agent tabs · 1 working")).toBeTruthy();

    // A change elsewhere is ignored; one to this environment re-reads.
    working = 2;
    dispatchResourceChange({ resource: "environment", id: "env-other", revision: 1 });
    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 2 });
    await waitFor(() => expect(screen.getByText("3 agent tabs · 2 working")).toBeTruthy(), {
      timeout: 2_000,
    });
    expect(getAgentRegistry).toHaveBeenCalledTimes(2);
  });
});
