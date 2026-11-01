import { expect, test } from "bun:test";
import type { NodeActivation } from "@orkestrator/protocol/graphs/run";
import { graphAgentBranch, graphAgentSession } from "./graph-agent-state.js";

test("agent acceptance survives persistence before a continuation is dispatched", () => {
  for (const agentStarted of [false, true]) {
    const activation = {
      key: "review#1",
      state: "running",
      session: {
        agent: "cursor",
        providerSessionId: "allocated",
        requestId: "request",
        dispatchState: "prepared",
        resultTransport: "tool-v1",
        agentStarted,
      },
    } as NodeActivation;
    const branch = graphAgentBranch(activation, { platform: "cursor" });
    expect(branch.agentStarted).toBe(agentStarted);
    const persisted = graphAgentSession(branch, {});
    expect(persisted?.agentStarted).toBe(agentStarted);
    expect(persisted?.providerSessionId).toBe("allocated");
  }
});
