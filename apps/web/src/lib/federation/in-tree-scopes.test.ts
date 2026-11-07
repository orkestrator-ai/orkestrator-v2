import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  installControlledTimeout,
  type ControlledTimeout,
} from "../../../../../tests/helpers/controlled-timeout";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import {
  closeInTreeScopes,
  holdInTreeScope,
  inTreeScopeHolds,
  type InTreeScopeHost,
} from "./in-tree-scopes";

const GRACE_MS = 4_321;
const LEAF = "bk_leaf" as BackendId;

let windowScope: WindowScope;
let timer: ControlledTimeout;
let opens: number;
let started: string[];
let stopped: string[];

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
    graceMs: GRACE_MS,
    startServices: (scope: NodeScope) => {
      started.push(scope.nodeId);
      return () => stopped.push(scope.nodeId);
    },
  });
}

beforeEach(() => {
  windowScope = new WindowScope();
  windowScope.open({
    role: "command",
    client: new FakeNodeClient({ nodeId: "bk_command" as BackendId }),
  });
  timer = installControlledTimeout(GRACE_MS, { label: "in-tree release grace", maxPending: 2 });
  opens = 0;
  started = [];
  stopped = [];
});

afterEach(() => {
  closeInTreeScopes(windowScope);
  timer.restore();
  windowScope.dispose();
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

test("the last release keeps the scope for the grace period, then stops its services and disposes it", async () => {
  const first = hold();
  const scope = await first.scope;
  first.release();
  first.release(); // idempotent
  expect(scope.disposed).toBe(false);
  expect(timer.pendingCount()).toBe(1);
  timer.advance();
  expect(stopped).toEqual([LEAF]);
  expect(scope.disposed).toBe(true);
  expect(windowScope.get(LEAF)).toBeNull();
});

test("a hold within the grace period cancels the release and keeps the same scope", async () => {
  const first = hold();
  const scope = await first.scope;
  first.release();
  const again = hold();
  expect(await again.scope).toBe(scope);
  expect(timer.pendingCount()).toBe(0);
  expect(opens).toBe(1);
  expect(started).toEqual([LEAF]);
  again.release();
  timer.advance();
  expect(scope.disposed).toBe(true);
});

test("a failed open rejects every hold and the next hold opens afresh", async () => {
  const failed = hold(LEAF, true);
  await expect(failed.scope).rejects.toThrow("refused the workspace grant");
  failed.release();
  expect(timer.pendingCount()).toBe(0);
  const retry = hold();
  expect((await retry.scope).nodeId).toBe(LEAF);
  expect(opens).toBe(2);
  retry.release();
  timer.advance();
});

test("a scope someone else opened is reused, its services started, and never disposed here", async () => {
  const foreign = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: LEAF }) });
  const held = hold();
  expect(await held.scope).toBe(foreign);
  expect(opens).toBe(0);
  held.release();
  timer.advance();
  expect(stopped).toEqual([LEAF]);
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
  timer.advance();
});

test("closing the window's in-tree scopes stops and disposes them now", async () => {
  const first = hold();
  const scope = await first.scope;
  closeInTreeScopes(windowScope);
  expect(stopped).toEqual([LEAF]);
  expect(scope.disposed).toBe(true);
  expect(inTreeScopeHolds(LEAF, windowScope)).toBe(0);
});
