import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, type Mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";
import { useAutoMergeToggle } from "./useAutoMergeToggle";

const invokeMock = invoke as unknown as Mock<(...args: unknown[]) => Promise<unknown>>;

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    projectId: "project-1",
    name: "feature",
    branch: "feature",
    containerId: null,
    status: "running",
    prUrl: "https://github.com/acme/repo/pull/7",
    prState: "open",
    hasMergeConflicts: false,
    createdAt: "2026-10-31T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

function Harness() {
  const selected = useEnvironmentStore((state) => state.environments[0] ?? null);
  const { enabled, saving, toggle } = useAutoMergeToggle(selected);
  return (
    <button type="button" aria-pressed={enabled} disabled={saving} onClick={() => void toggle()}>
      Auto-merge
    </button>
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  useEnvironmentStore.getState().setEnvironments([environment()]);
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useEnvironmentStore.getState().setEnvironments([]);
});

test("turning auto-merge on persists it and mirrors the backend's answer", async () => {
  invokeMock.mockImplementation(async (command, args) =>
    command === "set_environment_auto_merge"
      ? environment({ autoMerge: (args as { enabled: boolean }).enabled })
      : undefined,
  );
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Auto-merge" });
  expect(button.getAttribute("aria-pressed")).toBe("false");

  await act(async () => {
    fireEvent.click(button);
  });

  expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
    environmentId: "env-1",
    enabled: true,
  });
  expect(useEnvironmentStore.getState().environments[0]?.autoMerge).toBe(true);
  expect(button.getAttribute("aria-pressed")).toBe("true");

  await act(async () => {
    fireEvent.click(button);
  });
  expect(invokeMock).toHaveBeenLastCalledWith("set_environment_auto_merge", {
    environmentId: "env-1",
    enabled: false,
  });
  expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("a failed save leaves the switch where it was", async () => {
  invokeMock.mockImplementation(async () => {
    throw new Error("backend offline");
  });
  render(<Harness />);
  const button = screen.getByRole("button", { name: "Auto-merge" });

  await act(async () => {
    fireEvent.click(button);
  });

  expect(useEnvironmentStore.getState().environments[0]?.autoMerge).toBeUndefined();
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(button.hasAttribute("disabled")).toBe(false);
});
