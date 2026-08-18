import { beforeEach, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";

const overrideEnvironmentSetup = mock(
  async (environmentId: string) =>
    ({
      id: environmentId,
      setupPhase: "ready",
      setupOverride: true,
    }) as Environment,
);
const runEnvironmentSetup = mock(
  async (environmentId: string) =>
    ({
      id: environmentId,
      setupPhase: "ready",
      setupScriptsComplete: true,
    }) as Environment,
);

mock.module("@/lib/backend", () => ({ overrideEnvironmentSetup, runEnvironmentSetup }));

const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { forceResolveSetupRuntime, isSetupBlocked, isSetupPending, retrySetupRuntime } =
  await import("./setup-commands");

beforeEach(() => {
  overrideEnvironmentSetup.mockClear();
  runEnvironmentSetup.mockClear();
  useEnvironmentStore.setState({ environments: [] });
});

test("setup readiness comes only from the authoritative setup phase", () => {
  expect(isSetupPending({ setupPhase: "pending" })).toBe(true);
  expect(isSetupPending({ setupPhase: "running" })).toBe(true);
  expect(isSetupPending({ setupPhase: "failed" })).toBe(false);
  expect(isSetupPending({ setupPhase: "ready" })).toBe(false);
  expect(isSetupPending({})).toBe(true);
  expect(isSetupBlocked({ setupPhase: "failed" })).toBe(true);
  expect(isSetupBlocked({ setupPhase: "ready" })).toBe(false);
});

test("forceResolveSetupRuntime persists and projects the backend override", async () => {
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", setupPhase: "running" } as Environment],
  });

  await forceResolveSetupRuntime("env-1");

  expect(overrideEnvironmentSetup).toHaveBeenCalledWith("env-1");
  expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toEqual(
    expect.objectContaining({ setupPhase: "ready", setupOverride: true }),
  );
});

test("forceResolveSetupRuntime ignores unknown environments", async () => {
  await forceResolveSetupRuntime("missing");
  expect(overrideEnvironmentSetup).not.toHaveBeenCalled();
});

test("forceResolveSetupRuntime rejects when the backend override fails", async () => {
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });
  overrideEnvironmentSetup.mockRejectedValueOnce(new Error("backend unavailable"));

  await expect(forceResolveSetupRuntime("env-1")).rejects.toThrow("backend unavailable");
  expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase).toBe("failed");
});

test("retrySetupRuntime runs setup and projects the authoritative result", async () => {
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });

  await retrySetupRuntime("env-1");

  expect(runEnvironmentSetup).toHaveBeenCalledWith("env-1");
  expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toEqual(
    expect.objectContaining({ setupPhase: "ready", setupScriptsComplete: true }),
  );
});

test("retrySetupRuntime ignores unknown environments", async () => {
  await retrySetupRuntime("missing");
  expect(runEnvironmentSetup).not.toHaveBeenCalled();
});

test("retrySetupRuntime leaves the failed phase intact when retry rejects", async () => {
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });
  runEnvironmentSetup.mockRejectedValueOnce(new Error("retry unavailable"));

  await expect(retrySetupRuntime("env-1")).rejects.toThrow("retry unavailable");
  expect(useEnvironmentStore.getState().getEnvironmentById("env-1")?.setupPhase).toBe("failed");
});
