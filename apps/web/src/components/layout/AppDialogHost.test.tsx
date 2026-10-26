import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import * as realEnvironmentSettingsDialog from "@/components/environments/EnvironmentSettingsDialog";
import { invoke } from "@/lib/native/backend";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useConfigStore } from "@/stores/configStore";
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
    onRestart,
    onUpdate,
    open,
  }: {
    environment: Environment;
    onOpenChange: (open: boolean) => void;
    onRestart: (
      environmentId: string,
      options: { intent: "discard"; expectedContainerId: string | null },
    ) => Promise<void>;
    onUpdate: (environment: Environment) => void;
    open: boolean;
  }) =>
    open ? (
      <div role="dialog" aria-label="Environment Settings">
        <span>Settings for {environment.name}</span>
        <button type="button" onClick={() => onUpdate({ ...environment, status: "stopping" })}>
          Stop from settings
        </button>
        <button
          type="button"
          onClick={() =>
            void onRestart(environment.id, {
              intent: "discard",
              expectedContainerId: environment.containerId ?? null,
            })
          }
        >
          Restart from settings
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

  test("follows a background update to the requested environment", async () => {
    render(<AppDialogHost />);
    requestSettings("env-1");
    expect(await screen.findByText("Settings for first-env")).toBeTruthy();

    // The request pins an id, not a snapshot, so a sync that renames the
    // environment reaches the open dialog.
    act(() => {
      useEnvironmentStore.getState().updateEnvironment("env-1", { name: "renamed-by-sync" });
    });

    expect(screen.getByText("Settings for renamed-by-sync")).toBeTruthy();
  });

  test("restarts the requested environment through the backend", async () => {
    render(<AppDialogHost />);
    requestSettings("env-2");

    fireEvent.click(await screen.findByRole("button", { name: "Restart from settings" }));

    await waitFor(() =>
      expect(nativeInvoke).toHaveBeenCalledWith("recreate_environment", {
        environmentId: "env-2",
        intent: "discard",
        expectedContainerId: null,
      }),
    );
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

for (const failSnapshot of [false, true]) {
  test(`project deletion waits for an authoritative snapshot${failSnapshot ? " and retains the dialog on read failure" : " then deletes Home before removing the project"}`, async () => {
    const snapshot = deferred<Environment[]>();
    const homeDelete = deferred<void>();
    const calls: string[] = [];
    nativeInvoke.mockImplementation(async (command: string, args: Record<string, string>) => {
      if (command === "get_projects") return [project];
      if (command === "get_environment_snapshots") return snapshot.promise;
      if (command === "delete_environment") {
        calls.push(args.environmentId!);
        if (args.environmentId === "home") await homeDelete.promise;
      }
      if (command === "remove_project") calls.push("remove-project");
    });
    useProjectStore.setState({ projects: [project], hasLoaded: true });
    useEnvironmentStore.setState({ environments: [] });
    render(<AppDialogHost />);
    act(() => useAppDialogStore.getState().open({ kind: "delete-project", projectId: project.id }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    expect(calls).toEqual([]);
    await act(async () => {
      if (failSnapshot) snapshot.reject(new Error("snapshot unavailable"));
      else
        snapshot.resolve([
          environment("env-1", "first"),
          { ...environment("home", "app"), projectHome: true },
        ]);
    });
    if (failSnapshot) {
      expect(calls).toEqual([]);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(useAppDialogStore.getState().request?.kind).toBe("delete-project");
    } else {
      await waitFor(() => expect(calls).toEqual(["env-1", "home"]));
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      await act(async () => homeDelete.resolve());
      await waitFor(() => expect(calls).toEqual(["env-1", "home", "remove-project"]));
      await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    }
  });
}

test("partial deletion keeps the project and dialog and retries only remaining environments", async () => {
  const remaining = new Map(
    [environment("env-1", "first"), { ...environment("home", "app"), projectHome: true }].map(
      (env) => [env.id, env],
    ),
  );
  const calls: string[] = [];
  let fail = true;
  nativeInvoke.mockImplementation(async (command: string, args: Record<string, string>) => {
    if (command === "get_projects") return [project];
    if (command === "get_environment_snapshots") return Array.from(remaining.values());
    if (command === "delete_environment") {
      calls.push(args.environmentId!);
      if (args.environmentId === "home" && fail) throw new Error("busy");
      remaining.delete(args.environmentId!);
    }
    if (command === "remove_project") calls.push("remove-project");
  });
  useProjectStore.setState({ projects: [project], hasLoaded: true });
  useEnvironmentStore.setState({ environments: Array.from(remaining.values()) });
  render(<AppDialogHost />);
  act(() => useAppDialogStore.getState().open({ kind: "delete-project", projectId: project.id }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(useProjectStore.getState().deletingProjects.has(project.id)).toBe(false),
  );
  await waitFor(() => expect(calls).toEqual(["env-1", "home"]));
  expect(useProjectStore.getState().projects).toHaveLength(1);
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() => expect(calls).toEqual(["env-1", "home", "home", "remove-project"]));
  await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
});

test("repository settings waits for saved config, saves through the owner's project handler, and closes when removed", async () => {
  const initialConfig = useConfigStore.getState();
  const savedConfig = {
    ...initialConfig.config,
    repositories: { [project.id]: { defaultBranch: "saved-main", prBaseBranch: "saved-base" } },
  };
  try {
    useConfigStore.setState({ hasLoaded: false });
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "get_projects") return [project];
      if (command === "update_project") return { ...project, name: "renamed", localPath: null };
      if (command === "update_repository_config") return savedConfig;
      return [];
    });
    useProjectStore.setState({ projects: [project], hasLoaded: true });
    render(<AppDialogHost />);
    act(() =>
      useAppDialogStore.getState().open({ kind: "repository-settings", projectId: project.id }),
    );
    expectDomAbsent(screen.queryByLabelText("Name"));
    act(() => useConfigStore.getState().setConfig(savedConfig));
    fireEvent.click(await screen.findByRole("button", { name: "Branches" }));
    const branch = (await screen.findByLabelText("Default Branch")) as HTMLInputElement;
    expect(branch.value).toBe("saved-main");
    fireEvent.click(screen.getByRole("button", { name: "General" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        nativeInvoke.mock.calls.some(([command]) => command === "update_repository_config"),
      ).toBe(true),
    );
    expect(nativeInvoke).toHaveBeenCalledWith(
      "update_project",
      expect.objectContaining({
        projectId: project.id,
        updates: expect.objectContaining({ name: "renamed" }),
      }),
    );
    expect(nativeInvoke).toHaveBeenCalledWith(
      "update_repository_config",
      expect.objectContaining({
        projectId: project.id,
        repoConfig: expect.objectContaining({
          defaultBranch: "saved-main",
          prBaseBranch: "saved-base",
        }),
      }),
    );
    await waitFor(() => expect(useAppDialogStore.getState().request).toBeNull());
    act(() =>
      useAppDialogStore.getState().open({ kind: "repository-settings", projectId: project.id }),
    );
    await screen.findByLabelText("Name");
    act(() => useProjectStore.setState({ projects: [] }));
    expect(useAppDialogStore.getState().request).toBeNull();
    expectDomAbsent(screen.queryByLabelText("Name"));
  } finally {
    useConfigStore.setState(initialConfig, true);
  }
});
