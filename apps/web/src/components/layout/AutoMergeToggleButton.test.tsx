import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { afterEach, beforeEach, describe, expect, spyOn, type Mock, test } from "bun:test";
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

const destination = {
  expectedPrUrl: "https://github.com/acme/repo/pull/7",
  expectedBaseRef: "main",
  expectedTargetBranch: "main",
};

function autoMergeCalls() {
  return invokeMock.mock.calls
    .filter(([command]) => command === "set_environment_auto_merge")
    .map(([, args]) => args);
}

function toggle() {
  return screen.getByRole("button", { name: "Auto-merge" });
}

let restoreDomains: () => void;
beforeEach(() => {
  const domains = spyOn(getWindowScope().commandScope().client.domains, "get").mockReturnValue({
    "pull-requests": { min: 1, max: 4 },
  });
  restoreDomains = () => domains.mockRestore();
  invokeMock.mockReset();
  appCommandStore(environmentStore).getState().setEnvironments([environment()]);
});

afterEach(() => {
  restoreDomains();
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  appCommandStore(environmentStore).getState().setEnvironments([]);
  appCommandStore(prMonitorStore).setState({ states: new Map(), syncStatus: "idle" });
});

describe("AutoMergeToggleButton", () => {
  test("turns auto-merge on and off without a confirmation", async () => {
    answerAutoMerge();
    renderInAppCommandScope(
      <AutoMergeToggleButton environmentId="env-1" destination={destination} />,
    );
    expect(toggle().getAttribute("aria-pressed")).toBe("false");

    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(autoMergeCalls()).toEqual([{ environmentId: "env-1", enabled: true, ...destination }]);
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByRole("alertdialog") === null).toBe(true);

    await act(async () => {
      fireEvent.click(toggle());
    });
    expect(autoMergeCalls().at(-1)).toEqual({ environmentId: "env-1", enabled: false });
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  test("sends the accepted non-target base only after confirmation", async () => {
    answerAutoMerge();
    const release = { ...destination, expectedBaseRef: "release" };
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ prBaseBranch: "release" })]);
    renderInAppCommandScope(<AutoMergeToggleButton environmentId="env-1" destination={release} />);
    fireEvent.click(toggle());
    expect(autoMergeCalls()).toEqual([]);
    const accept = screen.getByRole("button", { name: "Accept and turn on auto-merge" });
    await act(async () => {
      fireEvent.click(accept);
    });
    expect(autoMergeCalls()).toEqual([{ environmentId: "env-1", enabled: true, ...release }]);
  });

  test.each([
    [{ prUrl: undefined, prState: undefined }],
    [{ prState: "merged" as const }],
    [{ prState: "closed" as const }],
  ])("is absent without an open pull request (%j)", (overrides) => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment(overrides)]);
    renderInAppCommandScope(
      <AutoMergeToggleButton environmentId="env-1" destination={destination} />,
    );
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
    renderInAppCommandScope(
      <AutoMergeToggleButton environmentId="env-1" destination={destination} />,
    );

    await act(async () => {
      fireEvent.focus(toggle());
    });
    expect((await screen.findAllByText(/Waiting: 2 checks failed/)).length).toBeGreaterThan(0);
  });
});
