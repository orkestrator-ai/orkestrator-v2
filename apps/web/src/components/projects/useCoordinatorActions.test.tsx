import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCoordinatorActions } from "./useCoordinatorActions";

afterEach(cleanup);

test.each([false, true])(
  "overlapping actions retain busy state after the first settles (reject=%s)",
  async (rejectFirst) => {
    const { result } = renderHook(() => useCoordinatorActions());
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve, reject) => {
      finishFirst = () => (rejectFirst ? reject(new Error("first failed")) : resolve());
    });
    const second = new Promise<void>((resolve) => {
      finishSecond = resolve;
    });
    let firstRun!: Promise<void>;
    let secondRun!: Promise<void>;
    act(() => {
      firstRun = result.current.runAction("conversation", () => first, {
        failureMessage: "failed",
      });
      secondRun = result.current.runAction("conversation", () => second, {
        failureMessage: "failed",
      });
    });
    expect(result.current.conversationBusy).toBe(true);
    await act(async () => {
      finishFirst();
      await firstRun;
    });
    expect(result.current.conversationBusy).toBe(true);
    expect(result.current.actionError).toBe(rejectFirst ? "first failed" : null);
    await act(async () => {
      finishSecond();
      await secondRun;
    });
    expect(result.current.conversationBusy).toBe(false);
  },
);
