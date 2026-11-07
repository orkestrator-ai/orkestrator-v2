import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  onGraphRunViewRequested,
  requestGraphRunView,
  takePendingGraphRunView,
  type GraphRunViewRequest,
} from "./graph-run-navigation";

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  takePendingGraphRunView();
});

function request(environmentId: string, mock = false): GraphRunViewRequest {
  return { runId: "run-1", projectId: "p1", environmentId, mock, title: "Review" };
}

/** A listener that serves one environment, as each terminal container does. */
function serve(environmentId: string, opened: GraphRunViewRequest[]): void {
  stops.push(
    onGraphRunViewRequested((next) => {
      if (next.environmentId !== environmentId) return false;
      opened.push(next);
      return true;
    }),
  );
}

describe("graph run view requests (launched and mock runs)", () => {
  test("the environment's listener opens it; nothing stays pending", () => {
    const opened: GraphRunViewRequest[] = [];
    serve("e1", opened);
    expect(requestGraphRunView(request("e1"))).toBe(true);
    expect(opened).toEqual([request("e1")]);
    expect(takePendingGraphRunView()).toBeNull();
  });

  test("a request no listener handles waits for its own environment only", () => {
    const opened: GraphRunViewRequest[] = [];
    serve("e1", opened);
    expect(requestGraphRunView(request("e2", true))).toBe(false);
    expect(opened).toEqual([]);
    expect(takePendingGraphRunView("e1")).toBeNull();
    expect(takePendingGraphRunView("e2")).toEqual(request("e2", true));
    expect(takePendingGraphRunView("e2")).toBeNull();
  });

  test("requests are per node: a leaf's run opens in the leaf's pane, never the command node's", () => {
    const windowScope = new WindowScope();
    try {
      const command = windowScope.open({ role: "command", client: new FakeNodeClient() });
      const leaf = windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "bk_leaf" as BackendId }),
      });
      const onCommand: GraphRunViewRequest[] = [];
      const onLeaf: GraphRunViewRequest[] = [];
      // Both nodes have an environment called "e1" on screen.
      const open =
        (into: GraphRunViewRequest[]) =>
        (next: GraphRunViewRequest): boolean => {
          if (next.environmentId !== "e1") return false;
          into.push(next);
          return true;
        };
      stops.push(onGraphRunViewRequested(open(onCommand), command));
      stops.push(onGraphRunViewRequested(open(onLeaf), leaf));

      expect(requestGraphRunView(request("e1"), leaf)).toBe(true);
      expect(onLeaf).toEqual([request("e1")]);
      expect(onCommand).toEqual([]);

      // An unhandled request waits on its own node only.
      expect(requestGraphRunView(request("e2"), leaf)).toBe(false);
      expect(takePendingGraphRunView("e2", command)).toBeNull();
      expect(takePendingGraphRunView("e2", leaf)).toEqual(request("e2"));
    } finally {
      windowScope.dispose();
    }
  });
});
