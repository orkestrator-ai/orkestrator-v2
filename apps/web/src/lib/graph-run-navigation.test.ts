import { afterEach, describe, expect, test } from "bun:test";
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
});
