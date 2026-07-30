import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMessagePartExpansionStore } from "@/stores/messagePartExpansionStore";
import { useMessagePartExpansion } from "./message-part-expansion";

beforeEach(() => {
  useMessagePartExpansionStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useMessagePartExpansionStore.getState().reset();
});

describe("useMessagePartExpansion", () => {
  test("starts collapsed and exposes a setter that opens and closes the part", () => {
    const { result } = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );

    expect(result.current[0]).toBe(false);

    act(() => {
      result.current[1](true);
    });
    expect(result.current[0]).toBe(true);
    expect(
      useMessagePartExpansionStore
        .getState()
        .expandedKeys
        .has("message-1/part-0"),
    ).toBe(true);

    act(() => {
      result.current[1](false);
    });
    expect(result.current[0]).toBe(false);
    expect(
      useMessagePartExpansionStore
        .getState()
        .expandedKeys
        .has("message-1/part-0"),
    ).toBe(false);
  });

  test("rehydrates an expanded part after the hook unmounts", () => {
    const first = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );

    act(() => {
      first.result.current[1](true);
    });
    first.unmount();

    const second = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );

    expect(second.result.current[0]).toBe(true);
  });

  test("keeps expansion state isolated by key", () => {
    const first = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );
    const second = renderHook(() =>
      useMessagePartExpansion("message-1/part-1")
    );

    act(() => {
      first.result.current[1](true);
    });

    expect(first.result.current[0]).toBe(true);
    expect(second.result.current[0]).toBe(false);
  });

  test("subscribes to expansion changes made outside the hook", () => {
    const { result } = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );

    act(() => {
      useMessagePartExpansionStore
        .getState()
        .setExpanded("message-1/part-0", true);
    });

    expect(result.current[0]).toBe(true);
  });

  test("targets the current key after the key changes", () => {
    const { result, rerender } = renderHook(
      ({ expansionKey }: { expansionKey: string }) =>
        useMessagePartExpansion(expansionKey),
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
    expect(keys.has("message-1/part-0")).toBe(false);
    expect(keys.has("message-2/part-0")).toBe(true);
  });

  test("keeps the setter stable while the key is unchanged", () => {
    const { result, rerender } = renderHook(() =>
      useMessagePartExpansion("message-1/part-0")
    );
    const setter = result.current[1];

    rerender();

    expect(result.current[1]).toBe(setter);
  });
});
