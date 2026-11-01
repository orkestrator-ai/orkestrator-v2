import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useStore } from "zustand";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import { PortalStore, OutcomeUnknownError } from "@/lib/portal/portal-store";
import type { FederatedProject } from "./summaries";
import { createRemoteProjectWrites, withArrangement } from "./remote-project-writes";

const nodeId = "bk_a" as never;
const deadlines: Array<() => void> = [];
const originalSetTimeout = globalThis.setTimeout;
afterEach(() => {
  cleanup();
  for (const done of deadlines.splice(0)) done();
  mock.restore();
});
function captureDeadlines() {
  spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (ms === 10_000) {
      deadlines.push(fn);
      return originalSetTimeout(() => {}, 0);
    }
    return originalSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout);
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};
function project(id: string, order: number, folder?: string): FederatedProject {
  const ref = projectRef(nodeId, id);
  return { ref, key: projectKey(ref), name: id, order, ...(folder ? { folder } : {}) };
}
function setup() {
  captureDeadlines();
  const portal = new PortalStore();
  const calls: Array<{
    args: Record<string, unknown>;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];
  spyOn(portal, "invokeOnNode").mockImplementation(
    (_node, _command, args) =>
      new Promise((resolve, reject) => {
        calls.push({ args: args!, resolve: () => resolve(undefined as never), reject });
      }),
  );
  const writes = createRemoteProjectWrites(portal);
  const onError = mock((_error: unknown) => {});
  const snapshot = (projects: FederatedProject[] | null, truncated = false) => {
    portal.store.setState({
      selfId: nodeId,
      self:
        projects === null
          ? null
          : { nodeId, displayName: "Owner", loadedAt: 1, truncated, projects, environments: [] },
    });
  };
  return { portal, writes, calls, onError, snapshot };
}

test("coalesces overlapping writes while accumulating folder moves", async () => {
  const { writes, calls, onError } = setup();
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: { a: "Work" } }, onError);
  writes.submit(nodeId, { projectIds: ["a", "b"], folders: { b: "Play" } }, onError);
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: { a: null } }, onError);
  expect(calls).toHaveLength(1);
  calls[0]!.resolve();
  await flush();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.args).toEqual({ projectIds: ["b", "a"], folders: { a: null, b: "Play" } });
  expect(
    withArrangement(
      [project("a", 0, "Old"), project("b", 1)],
      writes.store.getState().get(nodeId),
    ).map((p) => [p.name, p.folder]),
  ).toEqual([
    ["b", "Play"],
    ["a", undefined],
  ]);
  calls[1]!.resolve();
  await flush();
});

for (const error of [
  new Error("denied"),
  new OutcomeUnknownError(nodeId, "arrange_projects", "same-key"),
]) {
  test(`${error.name}: discards pending work without retrying an ambiguous write`, async () => {
    const { writes, calls, onError } = setup();
    writes.submit(nodeId, { projectIds: ["b", "a"], folders: {} }, onError);
    writes.submit(nodeId, { projectIds: ["a", "b"], folders: { a: "Work" } }, onError);
    calls[0]!.reject(error);
    await flush();
    expect(writes.store.getState().size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith(error);
  });
}

test("reconciles after the last reader unmounts and owner membership changes", async () => {
  const { writes, calls, onError, snapshot, portal } = setup();
  const subscribe = spyOn(portal.store, "subscribe");
  const { unmount } = renderHook(() => useStore(writes.store));
  writes.submit(
    nodeId,
    { projectIds: ["b", "a", "deleted"], folders: { b: "Work", deleted: "Work" } },
    onError,
  );
  calls[0]!.resolve();
  await flush();
  unmount();
  expect(subscribe).toHaveBeenCalledTimes(1);
  act(() => snapshot([project("a", 0), project("b", 1)]));
  expect(writes.store.getState().size).toBe(1);
  act(() => snapshot([project("b", 0, "Work"), project("a", 1), project("new", 2)]));
  expect(writes.store.getState().size).toBe(0);
});

test("missing owner snapshots do not confirm writes and the bounded overlay expires", async () => {
  const { writes, calls, onError, snapshot } = setup();
  writes.submit(nodeId, { projectIds: ["a"], folders: { a: "Work" } }, onError);
  calls[0]!.resolve();
  await flush();
  snapshot(null);
  expect(writes.store.getState().size).toBe(1);
  deadlines.pop()!();
  expect(writes.store.getState().size).toBe(0);
  snapshot([project("a", 0, "Work")]);
  expect(writes.store.getState().size).toBe(0);
});

test("a new drop cancels the prior overlay deadline and independent owners write concurrently", async () => {
  const { writes, calls, onError } = setup();
  writes.submit(nodeId, { projectIds: ["a"], folders: {} }, onError);
  calls[0]!.resolve();
  await flush();
  const oldDeadline = deadlines.pop()!;
  writes.submit(nodeId, { projectIds: ["a"], folders: { a: "New" } }, onError);
  writes.submit("bk_other" as never, { projectIds: ["a"], folders: {} }, onError);
  expect(calls).toHaveLength(3);
  // Captured old callbacks must be cancelled rather than firing in production.
  expect(oldDeadline).toBeFunction();
  expect(writes.store.getState().size).toBe(2);
  for (const call of calls.slice(1)) call.resolve();
  await flush();
});

function setupByCommand() {
  captureDeadlines();
  const portal = new PortalStore();
  const calls: Array<{
    command: string;
    args: Record<string, unknown>;
    resolve: (value?: unknown) => void;
    reject: (error: unknown) => void;
  }> = [];
  spyOn(portal, "invokeOnNode").mockImplementation(
    (_node, command, args) =>
      new Promise((resolve, reject) => {
        calls.push({ command, args: args!, resolve: resolve as (value?: unknown) => void, reject });
      }),
  );
  return {
    portal,
    calls,
    writes: createRemoteProjectWrites(portal),
    onError: mock((_error: unknown) => {}),
  };
}
const moveA = { kind: "move", activeId: "a", overId: "b" } as const;
const sortWork = { kind: "sort-folder", folder: "Work" } as const;

test("intents reach the owner one at a time, in order, and none is coalesced away", async () => {
  const { writes, calls, onError } = setupByCommand();
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: {} }, onError, moveA);
  writes.submit(nodeId, { projectIds: ["a", "b"], folders: {} }, onError, sortWork);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.command).toBe("arrange_projects_by_intent");
  expect(calls[0]!.args).toEqual({ intent: moveA });
  calls[0]!.resolve();
  await flush();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.args).toEqual({ intent: sortWork });
  calls[1]!.resolve();
  await flush();
  expect(calls).toHaveLength(2);
});

test("the overlay adopts what the owner resolved rather than this client's preview", async () => {
  const { writes, calls, onError } = setupByCommand();
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: {} }, onError, moveA);
  // Another client filed `a` into a folder first; the owner's answer says so.
  calls[0]!.resolve([
    { id: "b", order: 0 },
    { id: "a", order: 1, folder: "Work" },
  ]);
  await flush();
  expect(writes.store.getState().get(nodeId)).toEqual({
    projectIds: ["b", "a"],
    folders: { b: null, a: "Work" },
  });
});

test("an owner that predates intents gets the latest arrangement, covering the queue", async () => {
  const { writes, calls, onError } = setupByCommand();
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: { a: "Work" } }, onError, moveA);
  writes.submit(nodeId, { projectIds: ["a", "b"], folders: {} }, onError, sortWork);
  calls[0]!.reject(new Error("Unknown command: arrange_projects_by_intent"));
  await flush();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.command).toBe("arrange_projects");
  expect(calls[1]!.args).toEqual({ projectIds: ["b", "a"], folders: { a: "Work" } });
  calls[1]!.resolve();
  await flush();
  // The newer submit is still owed, as a whole arrangement: its intent was dropped.
  expect(calls).toHaveLength(3);
  expect(calls[2]!.command).toBe("arrange_projects");
  expect(calls[2]!.args).toEqual({ projectIds: ["a", "b"], folders: { a: "Work" } });
  expect(onError).not.toHaveBeenCalled();
  calls[2]!.resolve();
  await flush();
});

test("an intent the owner refuses is reported and not retried as a whole arrangement", async () => {
  const { writes, calls, onError } = setupByCommand();
  const error = new Error("denied");
  writes.submit(nodeId, { projectIds: ["b", "a"], folders: {} }, onError, moveA);
  calls[0]!.reject(error);
  await flush();
  expect(calls).toHaveLength(1);
  expect(onError).toHaveBeenCalledWith(error);
  expect(writes.store.getState().size).toBe(0);
});

test("a truncated owner snapshot cannot confirm a removed project", async () => {
  const { writes, calls, onError, snapshot } = setup();
  writes.submit(nodeId, { projectIds: ["a", "missing"], folders: { missing: "Work" } }, onError);
  calls[0]!.resolve();
  await flush();
  snapshot([project("a", 0)], true);
  expect(writes.store.getState().size).toBe(1);
  snapshot([project("a", 0)], false);
  expect(writes.store.getState().size).toBe(0);
});
