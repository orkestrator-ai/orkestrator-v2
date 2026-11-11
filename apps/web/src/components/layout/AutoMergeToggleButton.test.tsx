import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { afterEach, beforeEach, describe, expect, type Mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import { environmentStore } from "@/stores";
import { prMonitorStore } from "@/stores/prMonitorStore";
import type { Environment } from "@/types";
import { AutoMergeToggleButton } from "./AutoMergeToggleButton";
import { appCommandStore } from "@/test/app-command-store";

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
    prBaseBranch: "main",
    hasMergeConflicts: false,
    createdAt: "2026-10-31T00:00:00.000Z",
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

/** Answers `set_environment_auto_merge` as the backend would for an open PR. */
function answerAutoMerge() {
  invokeMock.mockImplementation(async (command, args) => {
    if (command !== "set_environment_auto_merge") return undefined;
    const { enabled, cleanupAfterMerge } = args as {
      enabled: boolean;
      cleanupAfterMerge?: boolean;
    };
    return environment({ autoMerge: enabled, autoMergeCleanup: enabled && !!cleanupAfterMerge });
  });
}

function toggle() {
  return screen.getByRole("button", { name: "Auto-merge" });
}

beforeEach(() => {
  invokeMock.mockReset();
  appCommandStore(environmentStore).getState().setEnvironments([environment()]);
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  appCommandStore(environmentStore).getState().setEnvironments([]);
  appCommandStore(prMonitorStore).setState({ states: new Map(), syncStatus: "idle" });
});

describe("AutoMergeToggleButton", () => {
  test("turns auto-merge on and off without a confirmation", async () => {
    answerAutoMerge();
    renderInAppCommandScope(<AutoMergeToggleButton environmentId="env-1" />);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: true,
    });
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("alertdialog") === null).toBe(true);

    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(invokeMock).toHaveBeenLastCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: false,
    });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  test.each([
    [{ prUrl: undefined, prState: undefined }],
    [{ prState: "merged" as const }],
    [{ prState: "closed" as const }],
  ])("is absent without an open pull request (%j)", (overrides) => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment(overrides)]);
    renderInAppCommandScope(<AutoMergeToggleButton environmentId="env-1" />);
    expect(screen.queryByRole("button", { name: "Auto-merge" }) === null).toBe(true);
  });

  test("names what auto-merge is waiting for in its tooltip", async () => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ autoMerge: true, prMergeability: "unstable" })]);
    const state: PrMonitorEnvironmentState = {
      environmentId: "env-1",
      mode: "normal",
      checkInProgress: false,
      consecutiveErrors: 0,
      lastCheckAt: "2026-11-06T10:00:00.000Z",
      lastSuccessfulCheckAt: "2026-11-06T10:00:00.000Z",
      prUrl: "https://github.com/acme/repo/pull/7",
      prState: "open",
      hasMergeConflicts: false,
      checkSummary: { passed: 18, total: 20, pending: 0 },
      viewerCanMerge: true,
      mergeability: "unstable",
    };
    appCommandStore(prMonitorStore).setState({
      states: new Map([["env-1", state]]),
      syncStatus: "current",
    });
    renderInAppCommandScope(<AutoMergeToggleButton environmentId="env-1" />);

    await act(async () => {
      fireEvent.focus(toggle());
    });
    expect((await screen.findAllByText(/Waiting: 2 checks failed/)).length).toBeGreaterThan(0);
  });
});
