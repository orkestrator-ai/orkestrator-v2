import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import { invoke } from "@/lib/native/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useEnvironmentStore } from "@/stores/environmentStore";
import { useProjectStore } from "@/stores/projectStore";
import type { Environment, Project } from "@/types";

const realEnvironmentSettingsDialogSnapshot = { ...realEnvironmentSettingsDialog };
const nativeInvoke = invoke as ReturnType<typeof mock>;
const initialProjects = useProjectStore.getState();
const project = { id: "project-1", name: "app", gitUrl: "", order: 0 } as unknown as Project;

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

afterEach(() => {
  cleanup();
  nativeInvoke.mockReset();
  useProjectStore.setState(initialProjects, true);
});

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

  test("confirms deleting a project, counting its environments but not its home", async () => {
    // The dialog's own project and environment hooks read the node's list.
    nativeInvoke.mockImplementation(async (command: string) =>
      command === "get_projects" ? [project] : undefined,
    );
    useProjectStore.setState({ projects: [project], hasLoaded: true });
    useEnvironmentStore.setState({
      environments: [
        environment("env-1", "first-env"),
        { ...environment("home", "app"), projectHome: true },
      ],
    });
    render(<AppDialogHost />);
    act(() => {
      useAppDialogStore.getState().open({ kind: "delete-project", projectId: "project-1" });
    });

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("remove app from your projects");
    expect(dialog.textContent).toContain(
      "This project has 1 environment that will also be deleted",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expectDomAbsent(screen.queryByRole("alertdialog"));
    expect(useAppDialogStore.getState().request).toBeNull();
    expect(nativeInvoke.mock.calls.some(([command]) => command === "remove_project")).toBe(false);
  });
});
