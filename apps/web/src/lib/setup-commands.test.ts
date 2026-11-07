import { beforeEach, expect, mock, test } from "bun:test";
import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
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

const approveEnvironmentSetup = mock(async () => ({}) as Environment);

mock.module("@/lib/backend", () => ({
  approveEnvironmentSetup,
  overrideEnvironmentSetup,
  runEnvironmentSetup,
}));

const { environmentStore } = await import("@/stores/environmentStore");
const { appCommandStore } = await import("@/test/app-command-store");
const { appCommandScope } = await import("@/lib/node-scope-slots");
const {
  approveSetupRuntime,
  forceResolveSetupRuntime,
  isSetupBlocked,
  isSetupPending,
  retrySetupRuntime,
} = await import("./setup-commands");

beforeEach(() => {
  approveEnvironmentSetup.mockClear();
  overrideEnvironmentSetup.mockClear();
  runEnvironmentSetup.mockClear();
  appCommandStore(environmentStore).setState({ environments: [] });
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
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", setupPhase: "running" } as Environment],
  });

  await forceResolveSetupRuntime("env-1", appCommandScope());

  expect(overrideEnvironmentSetup).toHaveBeenCalledWith("env-1");
  expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toEqual(
    expect.objectContaining({ setupPhase: "ready", setupOverride: true }),
  );
});

test("forceResolveSetupRuntime ignores unknown environments", async () => {
  await forceResolveSetupRuntime("missing", appCommandScope());
  expect(overrideEnvironmentSetup).not.toHaveBeenCalled();
});

test("forceResolveSetupRuntime rejects when the backend override fails", async () => {
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });
  overrideEnvironmentSetup.mockRejectedValueOnce(new Error("backend unavailable"));

  await expect(forceResolveSetupRuntime("env-1", appCommandScope())).rejects.toThrow(
    "backend unavailable",
  );
  expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.setupPhase).toBe(
    "failed",
  );
});

test("retrySetupRuntime runs setup and projects the authoritative result", async () => {
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });

  await retrySetupRuntime("env-1", appCommandScope());

  expect(runEnvironmentSetup).toHaveBeenCalledWith("env-1");
  expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")).toEqual(
    expect.objectContaining({ setupPhase: "ready", setupScriptsComplete: true }),
  );
});

test("retrySetupRuntime ignores unknown environments", async () => {
  await retrySetupRuntime("missing", appCommandScope());
  expect(runEnvironmentSetup).not.toHaveBeenCalled();
});

test("retrySetupRuntime leaves the failed phase intact when retry rejects", async () => {
  appCommandStore(environmentStore).setState({
    environments: [{ id: "env-1", setupPhase: "failed" } as Environment],
  });
  runEnvironmentSetup.mockRejectedValueOnce(new Error("retry unavailable"));

  await expect(retrySetupRuntime("env-1", appCommandScope())).rejects.toThrow("retry unavailable");
  expect(appCommandStore(environmentStore).getState().getEnvironmentById("env-1")?.setupPhase).toBe(
    "failed",
  );
});

test("approveSetupRuntime approves nothing for an unknown environment, and says so", async () => {
  const capture = captureLogs();
  try {
    await expect(
      approveSetupRuntime("missing", "hash", false, appCommandScope()),
    ).resolves.toBeUndefined();
    expect(approveEnvironmentSetup).not.toHaveBeenCalled();
    expect(capture.records()).toEqual([
      expect.objectContaining({
        level: "warn",
        area: "environment",
        event: "setup.unknown-environment",
        fields: { scope: "missing", action: "approveSetupRuntime" },
      }),
    ]);
  } finally {
    capture.restore();
  }
});
