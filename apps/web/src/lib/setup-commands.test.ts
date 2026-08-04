import { beforeEach, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";

const overrideEnvironmentSetup = mock(async (environmentId: string) => ({
  id: environmentId,
  setupPhase: "ready",
  setupOverride: true,
} as Environment));

mock.module("@/lib/backend", () => ({ overrideEnvironmentSetup }));

const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { forceResolveSetupRuntime, isSetupPending } = await import("./setup-commands");

beforeEach(() => {
  overrideEnvironmentSetup.mockClear();
  useEnvironmentStore.setState({ environments: [] });
});

test("setup readiness comes only from the authoritative setup phase", () => {
  expect(isSetupPending({ setupPhase: "pending" })).toBe(true);
  expect(isSetupPending({ setupPhase: "running" })).toBe(true);
  expect(isSetupPending({ setupPhase: "failed" })).toBe(true);
  expect(isSetupPending({ setupPhase: "ready" })).toBe(false);
  expect(isSetupPending({})).toBe(true);
});

test("forceResolveSetupRuntime persists and projects the backend override", async () => {
  useEnvironmentStore.setState({
    environments: [{ id: "env-1", setupPhase: "running" } as Environment],
  });

  forceResolveSetupRuntime("env-1");
  await Promise.resolve();
  await Promise.resolve();

  expect(overrideEnvironmentSetup).toHaveBeenCalledWith("env-1");
  expect(useEnvironmentStore.getState().getEnvironmentById("env-1")).toEqual(
    expect.objectContaining({ setupPhase: "ready", setupOverride: true }),
  );
});

test("forceResolveSetupRuntime ignores unknown environments", async () => {
  forceResolveSetupRuntime("missing");
  await Promise.resolve();
  expect(overrideEnvironmentSetup).not.toHaveBeenCalled();
});
