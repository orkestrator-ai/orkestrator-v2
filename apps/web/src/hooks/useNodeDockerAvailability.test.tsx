import { afterEach, expect, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { useNodeDockerAvailability } from "./useNodeDockerAvailability";

const windows: WindowScope[] = [];
afterEach(() => {
  cleanup();
  for (const windowScope of windows.splice(0)) windowScope.dispose();
});

test("one node's answer is never shown for another", async () => {
  const windowScope = new WindowScope();
  windows.push(windowScope);
  const pending = Promise.withResolvers<{ available: boolean; reason: null }>();
  const leaf = (id: string, answer: unknown): NodeScope =>
    windowScope.open({
      role: "leaf",
      client: new FakeNodeClient({
        nodeId: id as BackendId,
        invoke: { check_docker: () => answer },
      }),
    });
  const first = leaf("bk_first", { available: true, reason: null });
  const second = leaf("bk_second", pending.promise);
  const view = renderHook(({ scope }) => useNodeDockerAvailability(scope), {
    initialProps: { scope: first },
  });
  await waitFor(() => expect(view.result.current).toBe(true));
  view.rerender({ scope: second });
  expect(view.result.current).toBeNull();
  pending.resolve({ available: false, reason: null });
  await waitFor(() => expect(view.result.current).toBe(false));
});
