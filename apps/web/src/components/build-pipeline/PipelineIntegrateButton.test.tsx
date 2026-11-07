import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { invoke } from "@/lib/native/backend";
import type { PrMonitorEnvironmentState } from "@orkestrator/protocol/pr-monitor";
import { environmentStore } from "@/stores";
import { prMonitorStore } from "@/stores/prMonitorStore";
import type { Environment } from "@/types";
import { PipelineIntegrateButton } from "./PipelineIntegrateButton";
import { PipelineKeyInformationButton } from "./PipelineKeyInformation";
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

function integrateButton() {
  return screen.getByRole("button", { name: /^Integrat/ });
}

async function openConfirmation() {
  await act(async () => {
    fireEvent.click(integrateButton());
  });
  return screen.getByRole("alertdialog", { name: "Integrate Pull Request" });
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

/** A current monitor reading for env-1's pull request. */
function monitorReading(overrides: Partial<PrMonitorEnvironmentState> = {}) {
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
    checkSummary: { passed: 2, total: 2, pending: 0 },
    viewerCanMerge: true,
    mergeability: "clean",
    ...overrides,
  };
  appCommandStore(prMonitorStore).setState({
    states: new Map([["env-1", state]]),
    syncStatus: "current",
  });
}

describe("PipelineIntegrateButton", () => {
  test("confirms before turning on auto-merge, offering Auto-merge, Auto-merge & Cleanup and Cancel", async () => {
    answerAutoMerge();
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    expect(integrateButton().textContent).toBe("AIntegrate");

    const dialog = await openConfirmation();
    expect(within(dialog).getByText("feature")).toBeTruthy();
    expect(within(dialog).getByText("main")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" })).toBeTruthy();
    expect(invokeMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge" }));
    });

    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: true,
      cleanupAfterMerge: false,
    });
    expect(appCommandStore(environmentStore).getState().environments[0]).toMatchObject({
      autoMerge: true,
      autoMergeCleanup: false,
    });
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(integrateButton().textContent).toBe("AIntegrating");
  });

  test("Auto-merge & Cleanup asks the backend to delete the environment after the merge", async () => {
    answerAutoMerge();
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" }));
    });

    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: true,
      cleanupAfterMerge: true,
    });
    expect(appCommandStore(environmentStore).getState().environments[0]).toMatchObject({
      autoMerge: true,
      autoMergeCleanup: true,
    });
  });

  test("Cancel changes nothing", async () => {
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("an armed integration can be turned off from the confirmation", async () => {
    answerAutoMerge();
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ autoMerge: true, autoMergeCleanup: true })]);
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).getByText(/Auto-merge & Cleanup is already on/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Turn Off" }));
    });

    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: false,
    });
    expect(appCommandStore(environmentStore).getState().environments[0]).toMatchObject({
      autoMerge: false,
      autoMergeCleanup: false,
    });
  });

  test.each([
    [{ prUrl: undefined, prState: undefined }],
    [{ prState: "merged" as const }],
    [{ prState: "closed" as const }],
  ])("is disabled without an open pull request (%j)", (overrides) => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment(overrides)]);
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    expect(integrateButton().hasAttribute("disabled")).toBe(true);
  });

  test("a project's home checkout is offered Auto-merge without cleanup", async () => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ projectHome: true })]);
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).getByRole("button", { name: "Auto-merge" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Auto-merge & Cleanup" }) === null).toBe(
      true,
    );
  });
});

describe("PipelineIntegrateButton waiting states", () => {
  test("a ready pull request gets no waiting note", async () => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ prMergeability: "clean" })]);
    monitorReading();
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).queryByRole("note") === null).toBe(true);
  });

  test("failed checks that hold auto-merge back are named before and after turning it on", async () => {
    answerAutoMerge();
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ prMergeability: "unstable" })]);
    monitorReading({
      mergeability: "unstable",
      checkSummary: { passed: 18, total: 20, pending: 0 },
    });
    const warning = spyOn(toast, "warning");
    const success = spyOn(toast, "success");
    try {
      renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
      const dialog = await openConfirmation();
      expect(within(dialog).getByRole("note").textContent).toContain(
        "Auto-merge will wait: 2 checks failed, ",
      );

      await act(async () => {
        fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" }));
      });

      expect(success).not.toHaveBeenCalled();
      expect(warning).toHaveBeenCalledTimes(1);
      expect(String(warning.mock.calls[0]?.[1]?.description)).toContain(
        "Waiting: 2 checks failed, ",
      );
      const button = integrateButton();
      expect(button.getAttribute("aria-description")).toContain("2 checks failed");
      expect(button.querySelector('[data-integrate-hold="attention"]')).not.toBeNull();
    } finally {
      warning.mockRestore();
      success.mockRestore();
    }
  });

  test("running checks are a wait that needs nobody, so no warning is shown", async () => {
    answerAutoMerge();
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ prMergeability: "unstable" })]);
    monitorReading({
      mergeability: "unstable",
      checkSummary: { passed: 18, total: 20, pending: 2 },
    });
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).queryByRole("note") === null).toBe(true);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge" }));
    });
    expect(integrateButton().querySelector('[data-integrate-hold="attention"]') === null).toBe(
      true,
    );
  });
});

describe("Key information panel", () => {
  test("shows Integrate in its header, and the confirmation does not close the panel", async () => {
    renderInAppCommandScope(
      <PipelineKeyInformationButton keyInformation={undefined} environmentId="env-1" />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Key information" }));
    });
    const panel = screen.getByTestId("pipeline-key-information");
    expect(within(panel).getByRole("button", { name: "Integrate" })).toBeTruthy();

    const dialog = await openConfirmation();
    await act(async () => {
      fireEvent.pointerDown(within(dialog).getByRole("button", { name: "Cancel" }));
      fireEvent.keyDown(dialog, { key: "Escape" });
    });
    expect(screen.getByTestId("pipeline-key-information")).toBeTruthy();
  });

  test("leaves Integrate out without an environment", async () => {
    renderInAppCommandScope(<PipelineKeyInformationButton keyInformation={undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Key information" }));
    });
    expect(screen.queryByRole("button", { name: "Integrate" }) === null).toBe(true);
  });
});

for (const rejected of [true, false]) {
  test(`failed option save emits no success, rejection=${rejected}`, async () => {
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments([environment({ autoMerge: true })]);
    invokeMock.mockImplementation(async () => {
      if (rejected) throw new Error("save rejected");
      return environment({ autoMerge: false });
    });
    const success = spyOn(toast, "success");
    renderInAppCommandScope(<PipelineIntegrateButton environmentId="env-1" />);
    try {
      const dialog = await openConfirmation();
      await act(async () =>
        fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" })),
      );
      expect(success).not.toHaveBeenCalled();
      expect(
        appCommandStore(environmentStore).getState().environments[0]?.autoMergeCleanup,
      ).not.toBe(true);
    } finally {
      success.mockRestore();
    }
  });
}
