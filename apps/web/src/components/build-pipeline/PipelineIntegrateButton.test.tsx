import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { toast } from "sonner";
import { invoke } from "@/lib/native/backend";
import { useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";
import { PipelineIntegrateButton } from "./PipelineIntegrateButton";
import { PipelineKeyInformationButton } from "./PipelineKeyInformation";

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
  useEnvironmentStore.getState().setEnvironments([environment()]);
});

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useEnvironmentStore.getState().setEnvironments([]);
});

describe("PipelineIntegrateButton", () => {
  test("confirms before turning on auto-merge, offering Auto-merge, Auto-merge & Cleanup and Cancel", async () => {
    answerAutoMerge();
    render(<PipelineIntegrateButton environmentId="env-1" />);
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
    expect(useEnvironmentStore.getState().environments[0]).toMatchObject({
      autoMerge: true,
      autoMergeCleanup: false,
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(integrateButton().textContent).toBe("AIntegrating");
  });

  test("Auto-merge & Cleanup asks the backend to delete the environment after the merge", async () => {
    answerAutoMerge();
    render(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" }));
    });

    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: true,
      cleanupAfterMerge: true,
    });
    expect(useEnvironmentStore.getState().environments[0]).toMatchObject({
      autoMerge: true,
      autoMergeCleanup: true,
    });
  });

  test("Cancel changes nothing", async () => {
    render(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("an armed integration can be turned off from the confirmation", async () => {
    answerAutoMerge();
    useEnvironmentStore
      .getState()
      .setEnvironments([environment({ autoMerge: true, autoMergeCleanup: true })]);
    render(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).getByText(/Auto-merge & Cleanup is already on/)).toBeTruthy();

    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Turn Off" }));
    });

    expect(invokeMock).toHaveBeenCalledWith("set_environment_auto_merge", {
      environmentId: "env-1",
      enabled: false,
    });
    expect(useEnvironmentStore.getState().environments[0]).toMatchObject({
      autoMerge: false,
      autoMergeCleanup: false,
    });
  });

  test.each([
    [{ prUrl: undefined, prState: undefined }],
    [{ prState: "merged" as const }],
    [{ prState: "closed" as const }],
  ])("is disabled without an open pull request (%j)", (overrides) => {
    useEnvironmentStore.getState().setEnvironments([environment(overrides)]);
    render(<PipelineIntegrateButton environmentId="env-1" />);
    expect(integrateButton().hasAttribute("disabled")).toBe(true);
  });

  test("a project's home checkout is offered Auto-merge without cleanup", async () => {
    useEnvironmentStore.getState().setEnvironments([environment({ projectHome: true })]);
    render(<PipelineIntegrateButton environmentId="env-1" />);
    const dialog = await openConfirmation();
    expect(within(dialog).getByRole("button", { name: "Auto-merge" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Auto-merge & Cleanup" })).toBeNull();
  });
});

describe("Key information panel", () => {
  test("shows Integrate in its header, and the confirmation does not close the panel", async () => {
    render(<PipelineKeyInformationButton keyInformation={undefined} environmentId="env-1" />);
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
    render(<PipelineKeyInformationButton keyInformation={undefined} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Key information" }));
    });
    expect(screen.queryByRole("button", { name: "Integrate" })).toBeNull();
  });
});

for (const rejected of [true, false]) {
  test(`failed option save emits no success, rejection=${rejected}`, async () => {
    useEnvironmentStore.getState().setEnvironments([environment({ autoMerge: true })]);
    invokeMock.mockImplementation(async () => {
      if (rejected) throw new Error("save rejected");
      return environment({ autoMerge: false });
    });
    const success = spyOn(toast, "success");
    render(<PipelineIntegrateButton environmentId="env-1" />);
    try {
      const dialog = await openConfirmation();
      await act(async () =>
        fireEvent.click(within(dialog).getByRole("button", { name: "Auto-merge & Cleanup" })),
      );
      expect(success).not.toHaveBeenCalled();
      expect(useEnvironmentStore.getState().environments[0]?.autoMergeCleanup).not.toBe(true);
    } finally {
      success.mockRestore();
    }
  });
}
