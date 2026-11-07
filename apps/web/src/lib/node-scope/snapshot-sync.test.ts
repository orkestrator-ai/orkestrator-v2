import { afterEach, describe, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { invokeInScope } from "./scope-transport";
import {
  hasAuthoritativeReads,
  markScopeResyncing,
  noteAuthoritativeRead,
  ScopeResyncingError,
  scopeMutationGate,
  scopeSnapshotSync,
  SNAPSHOT_MUTATION_WAIT_MS,
  whenScopeLive,
} from "./snapshot-sync";
import { WindowScope } from "./window-scope";

const LEAF = "bk_leaf" as BackendId;

const windows: WindowScope[] = [];
let timer: ControlledTimeout | null = null;

function openLeaf() {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const client = new FakeNodeClient({
    nodeId: LEAF,
    invoke: { get_projects: [], update_project: { ok: true }, create_environment: { ok: true } },
  });
  return { scope: windowScope.open({ role: "leaf", client }), client };
}

/** Lets queued microtasks run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  timer?.restore();
  timer = null;
  for (const windowScope of windows.splice(0)) windowScope.dispose();
});

describe("snapshot sync state", () => {
  test("a scope never hydrated from a snapshot is live and never gates", () => {
    const { scope } = openLeaf();
    expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    expect(scopeMutationGate(scope)).toBeNull();
  });

  test("resyncing until every gated collection has its authoritative read, then live", () => {
    const { scope } = openLeaf();
    const seen: string[] = [];
    scopeSnapshotSync(scope).subscribe((sync) => seen.push(sync.state));
    markScopeResyncing(scope, 1_234);
    expect(scopeSnapshotSync(scope).get()).toEqual({
      state: "resyncing",
      savedAt: 1_234,
      pending: ["project", "environment", "config"],
    });
    noteAuthoritativeRead(scope, "project");
    noteAuthoritativeRead(scope, "config");
    expect(scopeSnapshotSync(scope).get().state).toBe("resyncing");
    noteAuthoritativeRead(scope, "environment");
    expect(scopeSnapshotSync(scope).get()).toEqual({ state: "live" });
    expect(seen.at(-1)).toBe("live");
    expect(hasAuthoritativeReads(scope)).toBe(true);
  });

  test("a read that landed before the mark is not waited for", () => {
    const { scope } = openLeaf();
    noteAuthoritativeRead(scope, "project");
    markScopeResyncing(scope, 1);
    const sync = scopeSnapshotSync(scope).get();
    expect(sync.state === "resyncing" && sync.pending).toEqual(["environment", "config"]);
  });
});

describe("mutations wait for live", () => {
  test("a write through the scope waits; a read goes at once", async () => {
    const { scope, client } = openLeaf();
    markScopeResyncing(scope, 1);
    const write = invokeInScope(scope, "update_project", { projectId: "p" });
    const read = invokeInScope(scope, "get_projects");
    await read;
    await flush();
    expect(client.calls("get_projects")).toHaveLength(1);
    expect(client.calls("update_project")).toHaveLength(0);

    noteAuthoritativeRead(scope, "project");
    noteAuthoritativeRead(scope, "environment");
    noteAuthoritativeRead(scope, "config");
    await expect(write).resolves.toEqual({ ok: true });
    expect(client.calls("update_project")).toHaveLength(1);
  });

  test("writes queued while resyncing reach the node in the order they were made", async () => {
    const { scope, client } = openLeaf();
    markScopeResyncing(scope, 1, ["project"]);
    const first = invokeInScope(scope, "update_project", { n: 1 });
    const second = invokeInScope(scope, "create_environment", { n: 2 });
    noteAuthoritativeRead(scope, "project");
    await Promise.all([first, second]);
    expect(client.invocations.map((call) => call.command)).toEqual([
      "update_project",
      "create_environment",
    ]);
  });

  test("past the bound the write is refused, never sent", async () => {
    timer = installControlledTimeout(SNAPSHOT_MUTATION_WAIT_MS, {
      label: "snapshot mutation wait",
    });
    const { scope, client } = openLeaf();
    markScopeResyncing(scope, 1);
    const write = invokeInScope(scope, "update_project");
    const refused = write.catch((error: unknown) => error);
    await flush();
    expect(timer.advance()).toBe(1);
    const error = await refused;
    expect(error).toBeInstanceOf(ScopeResyncingError);
    expect((error as ScopeResyncingError).reason).toBe("timeout");
    expect(client.calls("update_project")).toHaveLength(0);
  });

  test("disposing the scope refuses its waiting writes and clears their timers", async () => {
    timer = installControlledTimeout(SNAPSHOT_MUTATION_WAIT_MS, {
      label: "snapshot mutation wait",
    });
    const { scope } = openLeaf();
    markScopeResyncing(scope, 1);
    const waiting = whenScopeLive(scope).catch((error: unknown) => error);
    expect(timer.pendingCount()).toBe(1);
    scope.dispose();
    const error = await waiting;
    expect((error as ScopeResyncingError).reason).toBe("disposed");
    expect(timer.pendingCount()).toBe(0);
  });

  test("becoming live clears the waiting writes' timers", async () => {
    timer = installControlledTimeout(SNAPSHOT_MUTATION_WAIT_MS, {
      label: "snapshot mutation wait",
    });
    const { scope } = openLeaf();
    markScopeResyncing(scope, 1, ["config"]);
    const waiting = whenScopeLive(scope);
    expect(timer.pendingCount()).toBe(1);
    noteAuthoritativeRead(scope, "config");
    await waiting;
    expect(timer.pendingCount()).toBe(0);
  });
});
