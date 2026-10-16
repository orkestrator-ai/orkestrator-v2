import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";

const realEnvironmentSettingsDialogSnapshot = { ...realEnvironmentSettingsDialog };

mock.module("@/components/environments/EnvironmentSettingsDialog", () => ({
  EnvironmentSettingsDialog: ({
    environment,
    onOpenChange,
    onUpdate,
    open,
  }: {
    environment: Environment;
    onOpenChange: (open: boolean) => void;
    onUpdate: (environment: Environment) => void;
    open: boolean;
  }) =>
    open ? (
      <div role="dialog" aria-label="Environment Settings">
        <span>Settings for {environment.name}</span>
        <button type="button" onClick={() => onUpdate({ ...environment, status: "stopping" })}>
          Stop from settings
        </button>
        <button type="button" onClick={() => onOpenChange(false)}>
          Close settings
        </button>
      </div>
    ) : null,
}));

const { AppDialogHost } = await import("./AppDialogHost");

function environment(id: string, name: string): Environment {
  return {
    id,
    projectId: "project-1",
    name,
    order: 0,
    environmentType: "containerized",
    status: "running",
    networkAccessMode: "restricted",
    createdAt: "2026-10-16T00:00:00.000Z",
  } as Environment;
}

function requestSettings(environmentId: string) {
  act(() => {
    useAppDialogStore.getState().open({ kind: "environment-settings", environmentId });
  });
}

beforeEach(() => {
  useAppDialogStore.setState({ request: null });
  useEnvironmentStore.setState({
    environments: [environment("env-1", "first-env"), environment("env-2", "second-env")],
  });
});

afterEach(cleanup);

afterAll(() => {
  mock.module(
    "@/components/environments/EnvironmentSettingsDialog",
    () => realEnvironmentSettingsDialogSnapshot,
  );
});

describe("AppDialogHost", () => {
  test("shows the settings of the requested environment and closes them", async () => {
    render(<AppDialogHost />);
    expectDomAbsent(screen.queryByRole("dialog"));

    requestSettings("env-2");
    expect(await screen.findByText("Settings for second-env")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expectDomAbsent(screen.queryByRole("dialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
  });

  test("writes a settings change to the environment store, which every row reads", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");

    fireEvent.click(await screen.findByRole("button", { name: "Stop from settings" }));

    expect(
      useEnvironmentStore.getState().environments.find((candidate) => candidate.id === "env-1")
        ?.status,
    ).toBe("stopping");
  });

  test("drops the request when its environment disappears", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");
    expect(await screen.findByText("Settings for first-env")).toBeTruthy();

    act(() => {
      useEnvironmentStore.setState({ environments: [environment("env-2", "second-env")] });
    });

    expectDomAbsent(screen.queryByRole("dialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
    // A later environment that reuses the id does not reopen the dialog.
    act(() => {
      useEnvironmentStore.setState({ environments: [environment("env-1", "reused-id")] });
    });
    expectDomAbsent(screen.queryByRole("dialog"));
  });
});
