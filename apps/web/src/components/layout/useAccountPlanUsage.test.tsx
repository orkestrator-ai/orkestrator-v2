import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { invoke } from "@/lib/native/backend";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { useAccountPlanUsage } from "./useAccountPlanUsage";

const invokeMock = invoke as ReturnType<typeof mock>;
const initialProps = {
  enabled: true,
  platform: "claude",
  accountId: "work",
  refreshKey: "generation-1:running",
};
function snapshot(percent = 62): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    fetchedAt: "2026-11-03T12:00:00.000Z",
    windows: [{ window: "seven_day", label: "Weekly limit", usedPercent: percent }],
  };
}
function deferred() {
  let resolve!: (value: PlanUsageSnapshot) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<PlanUsageSnapshot>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle(request: ReturnType<typeof deferred>, value = snapshot()) {
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}
beforeEach(() => invokeMock.mockReset());
afterEach(cleanup);

test.each(["account", "platform"])("ignores a late response after %s changes", async (axis) => {
  const old = deferred();
  const current = deferred();
  invokeMock
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const { result, rerender } = renderHook(useAccountPlanUsage, { initialProps });
  expect(result.current).toBeUndefined();
  rerender({
    ...initialProps,
    [axis === "account" ? "accountId" : "platform"]: axis === "account" ? "personal" : "codex",
  });
  expect(result.current).toBeUndefined();
  await settle(current, snapshot(80));
  await settle(old, snapshot(10));
  expect(result.current?.[0]?.usedPercent).toBe(80);
  expect(invokeMock).toHaveBeenLastCalledWith("get_agent_account_usage", {
    platform: axis === "platform" ? "codex" : "claude",
    accountId: axis === "account" ? "personal" : "work",
  });
});

test("hides an old account's settled reading while the new account loads", async () => {
  const old = deferred();
  const current = deferred();
  invokeMock
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const { result, rerender } = renderHook(useAccountPlanUsage, { initialProps });
  await settle(old);
  rerender({ ...initialProps, accountId: "personal" });
  expect(result.current).toBeUndefined();
  await settle(current, snapshot(80));
  expect(result.current?.[0]?.usedPercent).toBe(80);
});

test("closing cancels a pending read and reopening reads again", async () => {
  const old = deferred();
  const current = deferred();
  invokeMock
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const { result, rerender } = renderHook(useAccountPlanUsage, { initialProps });
  rerender({ ...initialProps, enabled: false });
  await settle(old);
  expect(result.current).toBeUndefined();
  rerender(initialProps);
  expect(result.current).toBeUndefined();
  await settle(current, snapshot(80));
  expect(result.current?.[0]?.usedPercent).toBe(80);
  expect(invokeMock).toHaveBeenCalledTimes(2);
});

test("an unmounted read cannot seed a later mount", async () => {
  const old = deferred();
  const current = deferred();
  invokeMock
    .mockImplementationOnce(() => old.promise)
    .mockImplementationOnce(() => current.promise);
  const first = renderHook(useAccountPlanUsage, { initialProps });
  first.unmount();
  const second = renderHook(useAccountPlanUsage, { initialProps });
  await settle(current, snapshot(80));
  await settle(old, snapshot(10));
  expect(second.result.current?.[0]?.usedPercent).toBe(80);
});

test.each(["generation-1:idle", "generation-2:running"])(
  "refreshes for %s, retaining same-account data and ignoring superseded reads",
  async (refreshKey) => {
    const first = deferred();
    const superseded = deferred();
    const current = deferred();
    invokeMock
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => superseded.promise)
      .mockImplementationOnce(() => current.promise);
    const { result, rerender } = renderHook(useAccountPlanUsage, { initialProps });
    await settle(first);
    rerender({ ...initialProps, refreshKey });
    expect(result.current).toEqual(snapshot().windows);
    rerender({ ...initialProps, refreshKey: "generation-3:idle" });
    await settle(current, snapshot(80));
    await settle(superseded, snapshot(10));
    expect(result.current?.[0]?.usedPercent).toBe(80);
    expect(invokeMock).toHaveBeenCalledTimes(3);
  },
);

for (const failure of ["rejected", "unavailable", "error", "empty"] as const) {
  test.each(["reopen", "refresh"])(
    `${failure} hides previous windows and recovers on %s`,
    async (recovery) => {
      const first = deferred();
      const failed = deferred();
      const recovered = deferred();
      invokeMock
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => failed.promise)
        .mockImplementationOnce(() => recovered.promise);
      const { result, rerender } = renderHook(useAccountPlanUsage, { initialProps });
      await settle(first);
      rerender({ ...initialProps, refreshKey: "generation-1:idle" });
      if (failure === "rejected") {
        await act(async () => {
          failed.reject(new Error("usage read failed"));
          await failed.promise.catch(() => undefined);
        });
      } else {
        await settle(
          failed,
          failure === "empty" ? { ...snapshot(), windows: [] } : { ...snapshot(), status: failure },
        );
      }
      expect(result.current).toBeUndefined();
      if (recovery === "reopen") rerender({ ...initialProps, enabled: false });
      rerender({ ...initialProps, refreshKey: "generation-2:idle" });
      expect(result.current).toBeUndefined();
      await settle(recovered, snapshot(80));
      expect(result.current?.[0]?.usedPercent).toBe(80);
    },
  );
}
