import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useMultiReviewPrPhase } from "./useMultiReviewPrPhase";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import type { getNativeAgentSessionStateUpdate } from "@/lib/backend";

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
});

test("a slow mount read stays serialized with real coordinator ticks and stops on unmount", async () => {
  const { clock } = installFakeReadCoordinator();
  type Update = Awaited<ReturnType<typeof getNativeAgentSessionStateUpdate>>;
  const unchanged: Update = {
    status: "unchanged",
    viewVersion: 1,
    token: "same",
    identity: {
      backendInstanceId: "test",
      environmentId: "env-1",
      platform: "codex",
      logicalSessionKey: "env-1:pr",
      providerSessionId: "pr",
      sourceGeneration: 1,
    },
  };
  let finish!: (value: Update) => void;
  const load = mock(
    () =>
      new Promise<Update>((resolve) => {
        finish = resolve;
      }),
  );
  const { unmount } = renderHook(() =>
    useMultiReviewPrPhase({
      environmentId: "env-1",
      tabId: "pr",
      agent: "codex",
      active: true,
      loadSessionState: load,
    }),
  );
  await act(async () => {
    await clock.advance(6_000);
  });
  expect(load).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish(unchanged);
  });
  await act(async () => {
    await clock.advance(2_000);
  });
  expect(load).toHaveBeenCalledTimes(2);
  unmount();
  await act(async () => {
    finish(unchanged);
    await clock.advance(10_000);
  });
  expect(load).toHaveBeenCalledTimes(2);
});
