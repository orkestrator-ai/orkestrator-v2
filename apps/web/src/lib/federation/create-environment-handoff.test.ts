import { afterEach, expect, mock, test } from "bun:test";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import {
  reportCreateEnvironmentFailed,
  reportCreateEnvironmentOpened,
  stopCreateEnvironmentWatches,
  watchCreateEnvironmentRequest,
  type CreateEnvironmentRequestOutcome,
} from "./create-environment-handoff";

const initial = useRemoteWorkspaceStore.getState();

afterEach(() => {
  stopCreateEnvironmentWatches();
  useRemoteWorkspaceStore.setState(initial, true);
});

function request(nodeId: string, seq: number) {
  useRemoteWorkspaceStore.setState({
    requests: {
      [nodeId]: { seq, request: { projectId: "p", createEnvironmentProjectId: "p" } },
    },
  });
}

function watch(nodeId: string, seq: number, timeoutMs?: number) {
  const settled = mock((_outcome: CreateEnvironmentRequestOutcome) => undefined);
  const stop = watchCreateEnvironmentRequest(nodeId, seq, settled, timeoutMs);
  return { settled, stop };
}

test("settles once, when the node opens that request's form", () => {
  request("leaf", 4);
  const { settled } = watch("leaf", 4);
  reportCreateEnvironmentOpened("leaf", 3);
  reportCreateEnvironmentOpened("other", 4);
  expect(settled).not.toHaveBeenCalled();
  reportCreateEnvironmentOpened("leaf", 4);
  reportCreateEnvironmentFailed("leaf", 4, "late");
  expect(settled.mock.calls).toEqual([[{ kind: "opened" }]]);
});

test("a failure for the node, or for its request, is reported with its reason", () => {
  request("leaf", 1);
  const node = watch("leaf", 1);
  reportCreateEnvironmentFailed("leaf", null, "Could not connect: offline");
  expect(node.settled.mock.calls).toEqual([
    [{ kind: "failed", reason: "Could not connect: offline" }],
  ]);
  request("leaf", 2);
  const exact = watch("leaf", 2);
  reportCreateEnvironmentFailed("leaf", 2, "The project is not on that machine any more.");
  expect(exact.settled.mock.calls[0]?.[0]).toMatchObject({ kind: "failed" });
});

test("a request that is replaced or dropped before it opens is superseded", () => {
  request("leaf", 1);
  const replaced = watch("leaf", 1);
  request("leaf", 2);
  expect(replaced.settled.mock.calls).toEqual([[{ kind: "superseded" }]]);

  const dropped = watch("leaf", 2);
  useRemoteWorkspaceStore.setState({ requests: {} });
  expect(dropped.settled.mock.calls).toEqual([[{ kind: "superseded" }]]);

  // Already gone when the watch starts.
  const missing = watch("leaf", 9);
  expect(missing.settled.mock.calls).toEqual([[{ kind: "superseded" }]]);
});

test("nothing opening within the limit is a failure", () => {
  const clock = installControlledTimeout(4321, { label: "create-environment handoff" });
  try {
    request("leaf", 1);
    const { settled } = watch("leaf", 1, 4321);
    expect(settled).not.toHaveBeenCalled();
    expect(clock.advance()).toBe(1);
    expect(settled.mock.calls[0]?.[0]).toMatchObject({ kind: "failed" });
  } finally {
    clock.restore();
  }
});

test("a stopped watch never settles and leaves no timer behind", () => {
  const clock = installControlledTimeout(4321, { label: "create-environment handoff" });
  try {
    request("leaf", 1);
    const { settled, stop } = watch("leaf", 1, 4321);
    expect(clock.pendingCount()).toBe(1);
    stop();
    expect(clock.pendingCount()).toBe(0);
    reportCreateEnvironmentOpened("leaf", 1);
    request("leaf", 2);
    expect(settled).not.toHaveBeenCalled();
  } finally {
    clock.restore();
  }
});
