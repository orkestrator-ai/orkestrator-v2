import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { ReactNode } from "react";
import { NodeScopeProvider, WindowScopeProvider } from "@/lib/node-scope/providers";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import {
  messagePartExpansionKey,
  useMessagePartExpansionStore,
} from "@/stores/messagePartExpansionStore";
import { useMessagePartExpansion } from "./message-part-expansion";

/** Outside a provider the hook qualifies keys with the app's command node. */
const k = (key: string) => messagePartExpansionKey(getWindowScope().commandScope().nodeId, key);

beforeEach(() => {
  useMessagePartExpansionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.getState().reset();
});

describe("useMessagePartExpansion", () => {
  test("starts collapsed and exposes a setter that opens and closes the part", () => {
    const { result } = renderHook(() => useMessagePartExpansion("message-1/part-0"));

    expect(result.current[0]).toBe(false);

    act(() => {
      result.current[1](true);
    });
    expect(result.current[0]).toBe(true);
    expect(useMessagePartExpansionStore.getState().expandedKeys.has(k("message-1/part-0"))).toBe(
      true,
    );

    act(() => {
      result.current[1](false);
    });
    expect(result.current[0]).toBe(false);
    expect(useMessagePartExpansionStore.getState().expandedKeys.has(k("message-1/part-0"))).toBe(
      false,
    );
  });

  test("rehydrates an expanded part after the hook unmounts", () => {
    const first = renderHook(() => useMessagePartExpansion("message-1/part-0"));

    act(() => {
      first.result.current[1](true);
    });
    first.unmount();

    const second = renderHook(() => useMessagePartExpansion("message-1/part-0"));

    expect(second.result.current[0]).toBe(true);
  });

  test("keeps expansion state isolated by key", () => {
    const first = renderHook(() => useMessagePartExpansion("message-1/part-0"));
    const second = renderHook(() => useMessagePartExpansion("message-1/part-1"));

    act(() => {
      first.result.current[1](true);
    });

    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(false);
  });

  test("subscribes to expansion changes made outside the hook", () => {
    const { result } = renderHook(() => useMessagePartExpansion("message-1/part-0"));

    act(() => {
      useMessagePartExpansionStore.getState().setExpanded(k("message-1/part-0"), true);
    });

    expect(result.current[0]).toBe(true);
  });

  test("targets the current key after the key changes", () => {
    const { result, rerender } = renderHook(
      ({ expansionKey }: { expansionKey: string }) => useMessagePartExpansion(expansionKey),
      { initialProps: { expansionKey: "message-1/part-0" } },
    );

    const firstKeySetter = result.current[1];
    rerender({ expansionKey: "message-2/part-0" });

    expect(result.current[0]).toBe(false);
    expect(result.current[1]).not.toBe(firstKeySetter);

    act(() => {
      result.current[1](true);
    });

    const keys = useMessagePartExpansionStore.getState().expandedKeys;
    expect(keys.has(k("message-1/part-0"))).toBe(false);
    expect(keys.has(k("message-2/part-0"))).toBe(true);
  });

  test("protects its key from cap eviction while mounted, and stops once unmounted", () => {
    const store = useMessagePartExpansionStore.getState();
    const mounted = renderHook(() => useMessagePartExpansion("mounted-part"));

    act(() => {
      mounted.result.current[1](true);
    });
    act(() => {
      // Fill the remembered-key set past its cap with off-screen keys.
      for (let index = 0; index < 500; index++) {
        store.setExpanded(`off-screen-${index}`, true);
      }
    });

    expect(mounted.result.current[0]).toBe(true);
    expect(useMessagePartExpansionStore.getState().expandedKeys.has(k("mounted-part"))).toBe(true);

    mounted.unmount();
    act(() => {
      store.setExpanded(k("later-key"), true);
    });

    // Unmounted, it is the oldest key with nothing holding it on screen.
    expect(useMessagePartExpansionStore.getState().expandedKeys.has(k("mounted-part"))).toBe(false);
  });

  test("moves its cap protection to the new key when the key changes", () => {
    const store = useMessagePartExpansionStore.getState();
    const { rerender } = renderHook(
      ({ expansionKey }: { expansionKey: string }) => useMessagePartExpansion(expansionKey),
      { initialProps: { expansionKey: "first-key" } },
    );

    act(() => {
      store.setExpanded(k("first-key"), true);
      store.setExpanded(k("second-key"), true);
    });
    rerender({ expansionKey: "second-key" });

    act(() => {
      for (let index = 0; index < 500; index++) {
        store.setExpanded(`off-screen-${index}`, true);
      }
    });

    const keys = useMessagePartExpansionStore.getState().expandedKeys;
    expect(keys.has(k("second-key"))).toBe(true);
    expect(keys.has(k("first-key"))).toBe(false);
  });

  test("keeps the setter stable while the key is unchanged", () => {
    const { result, rerender } = renderHook(() => useMessagePartExpansion("message-1/part-0"));
    const setter = result.current[1];

    rerender();

    expect(result.current[1]).toBe(setter);
  });

  test("the same part id on two nodes is two disclosures", () => {
    const windowScope = new WindowScope();
    try {
      const nodeA = windowScope.open({
        role: "command",
        client: new FakeNodeClient({ nodeId: "bk_node-a" as BackendId }),
      });
      const nodeB = windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "bk_node-b" as BackendId }),
      });
      const inScope =
        (scope: typeof nodeA) =>
        ({ children }: { children: ReactNode }) => (
          <WindowScopeProvider windowScope={windowScope}>
            <NodeScopeProvider scope={scope}>{children}</NodeScopeProvider>
          </WindowScopeProvider>
        );
      const onA = renderHook(() => useMessagePartExpansion("message-1/part-0"), {
        wrapper: inScope(nodeA),
      });
      const onB = renderHook(() => useMessagePartExpansion("message-1/part-0"), {
        wrapper: inScope(nodeB),
      });

      act(() => onA.result.current[1](true));

      expect(onA.result.current[0]).toBe(true);
      expect(onB.result.current[0]).toBe(false);
      const keys = useMessagePartExpansionStore.getState().expandedKeys;
      expect(keys.has(messagePartExpansionKey(nodeA.nodeId, "message-1/part-0"))).toBe(true);
      expect(keys.has(messagePartExpansionKey(nodeB.nodeId, "message-1/part-0"))).toBe(false);
    } finally {
      cleanup();
      windowScope.dispose();
    }
  });
});
