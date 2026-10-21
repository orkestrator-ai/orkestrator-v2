import { useState } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
  type NodeSummary,
} from "@orkestrator/protocol/node-summaries";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { RemoteMachineTree } from "@/components/federation/RemoteMachineTree";
import { UnknownOutcomesNotice } from "@/components/federation/UnknownOutcomesNotice";
import { useRemoteMachineViews } from "@/components/federation/useMachineViews";
import { portalStore, type NodeOutcomeRecord } from "@/lib/portal/portal-store";
import { remoteOrdersFor } from "@/lib/federation/remote-order-writes";

const nodeId = "bk_remote" as BackendId;

function install() {
  const node: NodeSummary = {
    nodeId,
    view: {
      nodeId,
      enabled: true,
      displayName: "Remote",
      fallbackName: "Remote",
      routes: [],
      routeOrder: [],
      hasCredential: true,
      attachment: { status: "attached" },
      connection: { state: "connected", epoch: 1 },
      addedAt: "t",
      source: "portal",
    },
    available: true,
    freshness: "current",
    loadedAt: 1,
    truncated: new URLSearchParams(location.search).has("truncated"),
    lastError: null,
    projects: ["p", "q"].map((id, index) =>
      toNodeProjectSummary(nodeId, { id, name: id, order: index }, index)!,
    ),
    environments: ["a", "home", "b", "c", "d"].map((id, index) =>
      toNodeEnvironmentSummary(
        nodeId,
        {
          id,
          name: id,
          projectId: id === "d" ? "q" : "p",
          order: index,
          status: "running",
          projectHome: id === "home",
        },
        index,
      )!,
    ),
  };
  const state = createStore<{
    calls: string[][];
    pending: Array<(outcome: "ok" | "reject" | "unknown") => void>;
    owner: string[];
  }>(() => ({ calls: [], pending: [], owner: ["a", "home", "b", "c"] }));
  const outcomes: NodeOutcomeRecord[] = [];
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      if (command === "get_node_status") return { nodeId: "bk_self", mode: "command" } as T;
      if (command === "get_node_summaries")
        return { selfId: "bk_self", nodes: [structuredClone(node)] } as T;
      if (command === "get_backend_profile")
        return { revision: 1, displayName: "Self", colorToken: "teal", updatedAt: "t" } as T;
      if (command === "list_node_outcomes") return [...outcomes] as T;
      if (command === "invoke_on_node" && args?.command === "reorder_environments") {
        const ids = (args.args as { environmentIds: string[] }).environmentIds;
        state.setState((current) => ({ calls: [...current.calls, ids] }));
        return new Promise<T>((resolve, reject) => {
          state.setState((current) => ({
            pending: [
              ...current.pending,
              (outcome) => {
                if (outcome === "reject") {
                  reject(new Error("Owner refused reorder"));
                  return;
                }
                if (outcome === "unknown") {
                  outcomes.push({
                    outcomeId: "unknown",
                    nodeId,
                    command: "reorder_environments",
                    recordedAt: "t",
                  });
                  resolve({
                    outcome: "unknown",
                    requestKey: args.requestKey,
                    outcomeId: "unknown",
                  } as T);
                  return;
                }
                state.setState({ owner: ids });
                resolve({ outcome: "ok", result: {} } as T);
              },
            ],
          }));
        });
      }
      return {} as T;
    },
  };
  return {
    state,
    publish() {
      const ids = state.getState().owner;
      node.environments = node.environments.map((environment) => ({
        ...environment,
        order:
          environment.projectId === "p"
            ? ids.indexOf(environment.ref.environmentId)
            : environment.order,
      }));
      void portalStore.refresh();
    },
    finish(outcome: "ok" | "reject" | "unknown") {
      const [first, ...rest] = state.getState().pending;
      state.setState({ pending: rest });
      first?.(outcome);
    },
  };
}

function Tree({ visible }: { visible: boolean }) {
  const machines = useRemoteMachineViews();
  return (
    <>
      {visible && machines[0] && <RemoteMachineTree machine={machines[0]} />}
      <UnknownOutcomesNotice connectionId={nodeId} />
    </>
  );
}

// StrictMode may call a state initializer twice; both invocations must use
// the same fake owner and deferred requests as the visible controls.
let fixtureInstance: ReturnType<typeof install> | undefined;
function fixtureForWindow() {
  fixtureInstance ??= install();
  return fixtureInstance;
}

export function RemoteMachineTreeFixture() {
  const [fixture] = useState(fixtureForWindow);
  const [visible, setVisible] = useState(true);
  const state = useStore(fixture.state);
  const overlay = useStore(remoteOrdersFor(portalStore).store);
  return (
    <main className="max-w-lg p-4">
      <button onClick={() => setVisible((value) => !value)}>Toggle tree</button>
      <button onClick={() => fixture.finish("ok")}>Acknowledge</button>
      <button onClick={() => fixture.finish("reject")}>Reject</button>
      <button onClick={() => fixture.finish("unknown")}>Unknown</button>
      <button onClick={fixture.publish}>Publish owner</button>
      <output data-testid="calls">{JSON.stringify(state.calls)}</output>
      <output data-testid="pending">{state.pending.length}</output>
      <output data-testid="owner">{JSON.stringify(state.owner)}</output>
      <output data-testid="overlay">{overlay.size}</output>
      <FederationProvider>
        <Tree visible={visible} />
      </FederationProvider>
    </main>
  );
}
