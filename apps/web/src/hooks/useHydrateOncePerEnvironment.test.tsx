import { describe, expect, mock, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { useHydrateOncePerEnvironment } from "./useHydrateOncePerEnvironment";

type Props = { environments: Array<{ id: string; status?: string }> };

const noError = (_environmentId: string, _error: unknown) => undefined;

function rendered(
  hydrate: (environmentId: string) => Promise<unknown>,
  onError: (environmentId: string, error: unknown) => void = noError,
) {
  return renderHook<void, Props>(
    ({ environments }) => useHydrateOncePerEnvironment(environments, hydrate, onError),
    { initialProps: { environments: [{ id: "a" }, { id: "b" }] } },
  );
}

describe("useHydrateOncePerEnvironment", () => {
  test("a status change on an existing environment refetches nothing", () => {
    const hydrate = mock(async (_id: string) => undefined);
    const { rerender } = rendered(hydrate);
    expect(hydrate.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);

    rerender({ environments: [{ id: "a", status: "running" }, { id: "b" }] });
    expect(hydrate).toHaveBeenCalledTimes(2);
  });

  test("hydrates only the environment that is new", () => {
    const hydrate = mock(async (_id: string) => undefined);
    const { rerender } = rendered(hydrate);
    rerender({ environments: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    expect(hydrate.mock.calls.map(([id]) => id)).toEqual(["a", "b", "c"]);
  });

  test("an environment that leaves and returns hydrates again", () => {
    const hydrate = mock(async (_id: string) => undefined);
    const { rerender } = rendered(hydrate);
    rerender({ environments: [{ id: "b" }] });
    rerender({ environments: [{ id: "a" }, { id: "b" }] });
    expect(hydrate.mock.calls.map(([id]) => id)).toEqual(["a", "b", "a"]);
  });

  test("a failed restore reports and retries on the next list change", async () => {
    let attempts = 0;
    const hydrate = mock(async (id: string) => {
      if (id === "a" && ++attempts === 1) throw new Error("offline");
    });
    const onError = mock(noError);
    const { rerender } = rendered(hydrate, onError);
    await act(async () => {
      await Promise.resolve();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe("a");

    rerender({ environments: [{ id: "a", status: "running" }, { id: "b" }] });
    await act(async () => {
      await Promise.resolve();
    });
    expect(hydrate.mock.calls.map(([id]) => id)).toEqual(["a", "b", "a"]);
    expect(onError).toHaveBeenCalledTimes(1);

    rerender({ environments: [{ id: "a" }, { id: "b" }] });
    expect(hydrate).toHaveBeenCalledTimes(3);
  });
});

describe("useHydrateOncePerEnvironment per scope", () => {
  test("a different scope starts with nothing restored", () => {
    const windowScope = new WindowScope();
    try {
      const first = windowScope.open({
        role: "command",
        client: new FakeNodeClient({ nodeId: "bk_first" as BackendId }),
      });
      const second = windowScope.open({
        role: "leaf",
        client: new FakeNodeClient({ nodeId: "bk_second" as BackendId }),
      });
      const hydrate = mock(async (_id: string) => undefined);
      const { rerender } = renderHook<void, { scope: NodeScope }>(
        ({ scope }) => useHydrateOncePerEnvironment([{ id: "a" }], hydrate, noError, scope),
        { initialProps: { scope: first } },
      );
      rerender({ scope: first });
      expect(hydrate).toHaveBeenCalledTimes(1);
      rerender({ scope: second });
      expect(hydrate).toHaveBeenCalledTimes(2);
    } finally {
      windowScope.dispose();
    }
  });
});
