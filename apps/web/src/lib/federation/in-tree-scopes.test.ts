import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { FakeLifecycleClock, FakeMemoryWarnings } from "@/lib/node-scope/lifecycle.test-support";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  closeInTreeScopes,
  holdInTreeScope,
  inTreeScopeHolds,
  type InTreeScopeHost,
} from "./in-tree-scopes";

const SUSPEND_MS = 4_321;
const LEAF = "bk_leaf" as BackendId;

let windowScope: WindowScope;
let clock: FakeLifecycleClock;
let warnings: FakeMemoryWarnings;
let opens: number;
let started: string[];
let stopped: string[];
let reads: string[];

function host(fail = false): InTreeScopeHost {
  return {
    kind: "browser",
    async openLeafScope(target, nodeId) {
      opens += 1;
      if (fail) throw new Error("The node refused the workspace grant.");
      return target.open({ role: "leaf", client: new FakeNodeClient({ nodeId }) });
    },
  };
}

function hold(nodeId = LEAF, fail = false) {
  return holdInTreeScope(nodeId, {
    windowScope,
    host: host(fail),
    startServices: (scope: NodeScope) => {
      started.push(scope.nodeId);
      return () => stopped.push(scope.nodeId);
    },
    readHooks: {
      setHidden: (scope, hidden) => reads.push(`${hidden ? "hidden" : "shown"} ${scope.nodeId}`),
      resync: (scope) => reads.push(`resync ${scope.nodeId}`),
    },
  });
}

function show(nodeId: BackendId | null) {
  windowScope.select(nodeId ? { nodeId, projectId: null, environmentId: null } : null);
}

beforeEach(() => {
  clock = new FakeLifecycleClock();
  warnings = new FakeMemoryWarnings();
  windowScope = new WindowScope({
    lifecycle: { host: "browser", suspendAfterMs: SUSPEND_MS, pressureCheckMs: null },
    lifecycleDeps: {
      clock,
      visibility: null,
      memoryWarnings: warnings,
      readHeap: async () => null,
    },
  });
  windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  opens = 0;
  started = [];
  stopped = [];
  reads = [];
});

afterEach(() => {
  closeInTreeScopes(windowScope);
  windowScope.dispose();
  expect(clock.pending).toBe(0);
});

test("a hold opens the leaf scope once, starts its services and shares it with later holds", async () => {
  const first = hold();
  const second = hold();
  const [a, b] = await Promise.all([first.scope, second.scope]);
  expect(a).toBe(b);
  expect(a.role).toBe("leaf");
  expect(windowScope.get(LEAF)).toBe(a);
  expect(opens).toBe(1);
  expect(started).toEqual([LEAF]);
  expect(inTreeScopeHolds(LEAF, windowScope)).toBe(2);
  first.release();
  second.release();
});

test("the scope joins the window's lifecycle: live when shown, warm with its reads paused when hidden", async () => {
  show(LEAF);
  const held = hold();
  const scope = await held.scope;
  expect(scope.tier.get()).toBe("live");
  show(null);
  expect(scope.tier.get()).toBe("warm");
  expect(reads).toEqual([`shown ${LEAF}`, `hidden ${LEAF}`]);
  held.release();
});

test("releasing the last hold leaves the scope to its tiers: it suspends on the timer, not on release", async () => {
  const first = hold();
  const scope = await first.scope;
  first.release();
  first.release(); // idempotent
  expect(inTreeScopeHolds(LEAF, windowScope)).toBe(0);
  expect(scope.disposed).toBe(false);
  expect(scope.tier.get()).toBe("warm");
  await clock.advance(SUSPEND_MS);
  expect(scope.tier.get()).toBe("suspended");
  expect(stopped).toEqual([LEAF]);
  expect(scope.disposed).toBe(false);
  expect(windowScope.get(LEAF)).toBe(scope);
});

test("a hold of a suspended scope keeps it; showing it resumes it with a resync", async () => {
  const first = hold();
  const scope = await first.scope;
  first.release();
  await clock.advance(SUSPEND_MS);
  const again = hold();
  expect(await again.scope).toBe(scope);
  expect(opens).toBe(1);
  reads = [];
  show(LEAF);
  expect(scope.tier.get()).toBe("live");
  expect(started).toEqual([LEAF, LEAF]);
  expect(reads).toEqual([`shown ${LEAF}`, `resync ${LEAF}`]);
  again.release();
});

test("pressure takes a suspended scope back to summary; the next hold reopens it", async () => {
  const first = hold();
  const scope = await first.scope;
  warnings.warn(); // suspends the hidden scope
  expect(scope.tier.get()).toBe("suspended");
  warnings.warn(); // and back to summary
  expect(scope.disposed).toBe(true);
  expect(windowScope.get(LEAF)).toBeNull();
  const again = hold();
  const reopened = await again.scope;
  expect(reopened).not.toBe(scope);
  expect(opens).toBe(2);
  first.release();
  again.release();
});

test("a failed open rejects every hold and the next hold opens afresh", async () => {
  const failed = hold(LEAF, true);
  await expect(failed.scope).rejects.toThrow("refused the workspace grant");
  failed.release();
  const retry = hold();
  expect((await retry.scope).nodeId).toBe(LEAF);
  expect(opens).toBe(2);
  retry.release();
});

test("a scope someone else opened is reused, its services started, and never disposed here", async () => {
  const foreign = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: LEAF }) });
  const held = hold();
  expect(await held.scope).toBe(foreign);
  expect(opens).toBe(0);
  held.release();
  // Pressure gives it back instead of disposing it.
  warnings.warn();
  warnings.warn();
  expect(stopped).toEqual([LEAF]);
  expect(foreign.disposed).toBe(false);
  expect((foreign.client as FakeNodeClient).suspended).toBe(false);
  closeInTreeScopes(windowScope);
  expect(foreign.disposed).toBe(false);
});

test("a scope disposed elsewhere is reopened by the next hold", async () => {
  const first = hold();
  const scope = await first.scope;
  scope.dispose();
  const second = hold();
  const reopened = await second.scope;
  expect(reopened).not.toBe(scope);
  expect(reopened.disposed).toBe(false);
  expect(opens).toBe(2);
  first.release();
  second.release();
});

test("closing the window's in-tree scopes stops and disposes them now", async () => {
  const first = hold();
  const scope = await first.scope;
  closeInTreeScopes(windowScope);
  expect(stopped).toEqual([LEAF]);
  expect(scope.disposed).toBe(true);
  expect(inTreeScopeHolds(LEAF, windowScope)).toBe(0);
  expect(windowScope.lifecycle.size).toBe(0);
});

test("a suspend hands the node's attention off before its client's streams close (5001)", async () => {
  const handoffs: string[] = [];
  let settle: () => void = () => undefined;
  const held = holdInTreeScope(LEAF, {
    windowScope,
    host: host(),
    startServices: () => () => undefined,
    readHooks: {},
    handoff: (scope) => {
      handoffs.push(`${scope.nodeId} ${scope.tier.get()}`);
      return new Promise<void>((resolve) => {
        settle = resolve;
      });
    },
  });
  const scope = await held.scope;
  const client = scope.client as FakeNodeClient;
  await clock.advance(SUSPEND_MS);
  expect(handoffs).toEqual([`${LEAF} warm`]);
  expect(scope.tier.get()).toBe("suspended");
  expect(client.suspended).toBe(false);
  settle();
  await clock.advance(0);
  expect(client.suspended).toBe(true);
  held.release();
});
