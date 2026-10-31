import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as federation from "@/components/federation/FederationProvider";
import * as commandNode from "@/components/federation/useCommandNode";
import type { BackendId } from "@orkestrator/protocol/federation";
import { SettingsPage, SettingsScopeBanner } from "./SettingsPage";

import { FederationProvider } from "@/components/federation/FederationProvider";
import { GlobalSettingsHost } from "@/components/layout/GlobalSettingsHost";
import { DockerAvailabilityProvider } from "@/contexts/DockerAvailabilityContext";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { requestGlobalSettings } from "@/lib/settings-navigation";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import { useGlobalSettingsStore } from "@/stores/globalSettingsStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useAccountMachineStore } from "./account-machine";

afterEach(() => {
  cleanup();
  mock.restore();
});

function installScope(enabled = true) {
  spyOn(federation, "useFederation").mockReturnValue({
    enabled,
    boundMachine: { name: "Leaf", colorToken: "teal" },
  } as never);
  spyOn(commandNode, "useCommandNode").mockReturnValue({
    nodeId: "bk_command" as BackendId,
    name: "Desk",
    colorToken: "teal",
    workspaceHere: false,
  });
}

test("scope banners name the owner of each section in a leaf window", () => {
  installScope();
  for (const section of [
    "platforms",
    "network",
    "docker",
    "container",
    "disk-usage",
    "skills",
    "sounds",
  ] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toBe(
      "Machine settings for Leaf. Changes apply to this machine.",
    );
    view.unmount();
  }
  for (const section of ["review", "messaging"] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toContain("Preferences for Desk");
    view.unmount();
  }
  for (const section of [
    "defaults",
    "terminal",
    "claude",
    "codex",
    "cursor",
    "grok",
    "opencode",
    "pi",
  ] as const) {
    const view = render(<SettingsScopeBanner section={section} />);
    expect(screen.getByTestId("settings-scope").textContent).toContain(
      "Preferences come from Desk",
    );
    expect(screen.getByTestId("settings-scope").textContent).toContain("belong to Leaf");
    view.unmount();
  }
  render(<SettingsScopeBanner section="machines" />);
  expect(screen.getByTestId("settings-scope").textContent).toContain("Command node: Desk");
});

test("single-machine windows only show scope for the Machines section", () => {
  installScope(false);
  const view = render(<SettingsScopeBanner section="network" />);
  const banner = screen.queryByTestId("settings-scope");
  expect(banner).toBeNull();
  view.rerender(<SettingsScopeBanner section="machines" />);
  expect(screen.getByTestId("settings-scope")).toBeTruthy();
});

test("the machine picked in the header owns its machine settings", () => {
  installScope();
  render(
    <SettingsScopeBanner section="network" machine={{ name: "Build box", colorToken: "amber" }} />,
  );
  expect(screen.getByTestId("settings-scope").textContent).toBe(
    "Machine settings for Build box. Changes apply to this machine.",
  );
  cleanup();
  render(
    <SettingsScopeBanner section="claude" machine={{ name: "Build box", colorToken: "amber" }} />,
  );
  expect(screen.getByTestId("settings-scope").textContent).toContain("belong to Build box");
});

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const initialPortal = portalStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const initialConfig = useConfigStore.getState();
const initialSettings = useGlobalSettingsStore.getState();
const initialEnvironments = useEnvironmentStore.getState();
afterEach(() => {
  portalStore.store.setState(initialPortal);
  useRemoteWorkspaceStore.setState(initialRemote);
  useConfigStore.setState(initialConfig);
  useGlobalSettingsStore.setState(initialSettings);
  useEnvironmentStore.setState(initialEnvironments);
  useAccountMachineStore.getState().choose(undefined);
  invokeMock.mockReset();
});

test("the Docker tab renders while global config is still loading", async () => {
  installScope(false);
  // The resolver still reads the provider's portal snapshot in a single-machine window.
  spyOn(federation, "useFederation").mockReturnValue({
    enabled: false,
    bound: null,
    portalState: initialPortal,
  } as never);
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_config") return new Promise(() => {});
    if (command === "get_docker_system_stats") return { containersRunning: 0, containersTotal: 0 };
    if (command === "get_orkestrator_containers" || command === "get_projects") return [];
    return undefined;
  });
  render(<SettingsPage open defaultSection="docker" onOpenChange={() => undefined} />);
  expect(await screen.findByText("System Resources")).toBeTruthy();
  expect(useConfigStore.getState().isLoading).toBe(true);
  expect(screen.queryByText("Loading Docker stats...")).toBeNull();
});

test("a remote workspace opens Docker in parent Settings and every action targets its selected host", async () => {
  const nodes = [
    {
      nodeId: "bk_remote",
      view: { displayName: "Build box", connection: { state: "connected" } },
      projects: [],
      environments: [],
      freshness: "current",
    },
  ] as never;
  portalStore.store.setState({ ...initialPortal, selfId: "bk_command" as BackendId, nodes });
  useRemoteWorkspaceStore.setState({
    active: { nodeId: "bk_remote", projectId: "remote-project", environmentId: null },
  });
  useAccountMachineStore.getState().choose(undefined);
  const routed: Array<{ nodeId: string; command: string; args: Record<string, unknown> }> = [];
  const direct: string[] = [];
  const config = initialConfig.config;
  function answer(command: string, remote: boolean) {
    if (command === "get_config") return config;
    if (command === "check_docker") return { available: true, reason: null };
    if (command === "get_docker_system_stats") return { containersRunning: 1, containersTotal: 1 };
    if (command === "get_projects") return [{ id: "remote-project", name: "Remote project" }];
    if (command === "get_orkestrator_containers")
      return [
        {
          id: "remote-container",
          name: remote ? "Remote container" : "Command container",
          state: "running",
          isAssigned: false,
          cleanupExclusion: null,
          cpuPercent: null,
          projectId: "remote-project",
          created: null,
        },
      ];
    if (command === "get_docker_image_status")
      return {
        state: "missing",
        imageRef: "remote-image",
        missingCapabilities: [],
        manifest: null,
      };
    if (command === "get_docker_topology") return { kind: "local-engine" };
    if (command === "get_host_maintenance") return { tasks: {} };
    if (command === "start_host_image_update") return { id: "remote-download", state: "running" };
    if (command === "reattach_container")
      return { id: "remote-environment", projectId: "remote-project" };
    if (command === "docker_cleanup_preview")
      return {
        selectionToken: "remote-token",
        rows: [
          {
            kind: "container",
            id: "remote-container",
            name: "Remote orphan",
            classification: "eligible",
            sizeBytes: 100,
          },
        ],
      };
    if (command === "docker_cleanup_execute")
      return {
        removed: 1,
        alreadyAbsent: 0,
        conflicts: 0,
        skipped: 0,
        failed: 0,
        reclaimedBytes: 100,
      };
    return undefined;
  }
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_backend_profile")
      return { revision: 1, displayName: "Command", colorToken: "blue", updatedAt: "" };
    if (command === "get_node_summaries") return { selfId: "bk_command", nodes };
    if (command === "get_node_status") return { nodeId: "bk_command" };
    if (command === "invoke_on_node") {
      routed.push(args as (typeof routed)[number]);
      return { outcome: "ok", result: answer(args.command as string, true) };
    }
    direct.push(command);
    return answer(command, false);
  });
  render(
    <FederationProvider>
      <DockerAvailabilityProvider available>
        <GlobalSettingsHost />
      </DockerAvailabilityProvider>
    </FederationProvider>,
  );
  act(() => requestGlobalSettings("docker"));
  await screen.findByText("Remote container");
  expect(
    screen.getAllByRole("button", { name: "Build box" })[0]!.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByText(/Remote project/)).toBeTruthy();
  fireEvent.click(screen.getByTitle("Stop container"));
  await waitFor(() =>
    expect(routed.some((call) => call.command === "docker_stop_container")).toBe(true),
  );
  fireEvent.click(screen.getByTitle("Delete container"));
  await waitFor(() =>
    expect(routed.some((call) => call.command === "docker_remove_container")).toBe(true),
  );

  fireEvent.click(screen.getByTitle("Reattach to project"));
  const dialog = screen.getByRole("alertdialog");
  fireEvent.pointerDown(within(dialog).getByRole("combobox"), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
  fireEvent.click(await screen.findByRole("option", { name: "Remote project" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Reattach" }));
  await waitFor(() =>
    expect(routed.some((call) => call.command === "reattach_container")).toBe(true),
  );
  expect(useEnvironmentStore.getState().environments).toEqual(initialEnvironments.environments);
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

  fireEvent.click(screen.getByRole("button", { name: "Review cleanup…" }));
  await screen.findByText("Can be removed (1)");
  fireEvent.click(screen.getByRole("button", { name: "Remove 1 selected" }));
  await screen.findByText(/1 removed/);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(await screen.findByRole("button", { name: "Download image" }));
  await waitFor(() =>
    expect(routed.some((call) => call.command === "start_host_image_update")).toBe(true),
  );

  const remoteCommands = routed.map((call) => call.command);
  expect(remoteCommands).toEqual(
    expect.arrayContaining([
      "check_docker",
      "get_docker_system_stats",
      "get_orkestrator_containers",
      "get_projects",
      "get_docker_image_status",
      "get_docker_topology",
      "get_host_maintenance",
      "docker_stop_container",
      "docker_remove_container",
      "reattach_container",
      "docker_cleanup_preview",
      "docker_cleanup_execute",
      "start_host_image_update",
    ]),
  );
  expect(routed.every((call) => call.nodeId === "bk_remote")).toBe(true);
  expect(
    direct.filter((command) => remoteCommands.includes(command) && command !== "get_config"),
  ).toEqual([]);
  expect(routed.find((call) => call.command === "reattach_container")?.args).toEqual({
    projectId: "remote-project",
    containerId: "remote-container",
    name: "Remote container",
  });
  expect(routed.find((call) => call.command === "docker_cleanup_execute")?.args).toEqual({
    selectionToken: "remote-token",
    containerIds: ["remote-container"],
    volumeNames: [],
    networkNames: [],
  });

  // Switching back loads the command node and discards the remote UI.
  fireEvent.click(screen.getAllByRole("button", { name: /Command.*command node/ })[0]!);
  expect(await screen.findByText("Command container")).toBeTruthy();
  expect(screen.queryByText("Remote container")).toBeNull();
});

for (const scenario of [
  "availability",
  "stats with reattach",
  "pending cleanup",
  "selected cleanup",
] as const) {
  test(`switching Docker hosts discards ${scenario} and ignores late responses`, async () => {
    const callbacks = new Map<number, () => void>();
    let nextId = 0;
    spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      callbacks.set(++nextId, callback);
      return nextId;
    }) as typeof setInterval);
    spyOn(globalThis, "clearInterval").mockImplementation(((id: number) => {
      callbacks.delete(id);
    }) as typeof clearInterval);
    const nodes = [
      {
        nodeId: "bk_remote",
        view: { displayName: "Build box", connection: { state: "connected" } },
        projects: [],
        environments: [],
        freshness: "current",
      },
    ] as never;
    portalStore.store.setState({ ...initialPortal, selfId: "bk_command" as BackendId, nodes });
    useAccountMachineStore.getState().choose("bk_remote");
    let resolveOld!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      resolveOld = resolve;
    });
    let deferStats = false;
    const routed: Array<{ command: string; args: Record<string, unknown> }> = [];
    const direct: Array<{ command: string; args: Record<string, unknown> }> = [];
    const preview = (remote: boolean) => ({
      selectionToken: remote ? "old-token" : "new-token",
      rows: [
        {
          kind: "container",
          id: remote ? "old-container" : "new-container",
          name: remote ? "Old orphan" : "New orphan",
          classification: "eligible",
          sizeBytes: 100,
        },
      ],
    });
    function answer(command: string, remote: boolean): unknown {
      if (command === "get_config") return initialConfig.config;
      if (command === "check_docker")
        return remote && scenario === "availability" ? pending : { available: true, reason: null };
      if (command === "get_docker_system_stats")
        return remote && deferStats
          ? pending
          : { containersRunning: remote ? 1 : 2, containersTotal: 2 };
      if (command === "get_projects")
        return [
          {
            id: remote ? "old-project" : "new-project",
            name: remote ? "Old project" : "New project",
          },
        ];
      if (command === "get_orkestrator_containers")
        return [
          {
            id: remote ? "old-container" : "new-container",
            name: remote ? "Old container" : "New container",
            state: "running",
            isAssigned: false,
            cleanupExclusion: null,
            cpuPercent: null,
            projectId: remote ? "old-project" : "new-project",
            created: null,
          },
        ];
      if (command === "docker_cleanup_preview")
        return remote && scenario === "pending cleanup" ? pending : preview(remote);
      if (command === "docker_cleanup_execute")
        return {
          removed: 1,
          alreadyAbsent: 0,
          conflicts: 0,
          skipped: 0,
          failed: 0,
          reclaimedBytes: 100,
        };
      return undefined;
    }
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
      if (command === "get_backend_profile")
        return { revision: 1, displayName: "Command", colorToken: "blue", updatedAt: "" };
      if (command === "get_node_summaries") return { selfId: "bk_command", nodes };
      if (command === "get_node_status") return { nodeId: "bk_command" };
      if (command === "invoke_on_node") {
        routed.push(args as (typeof routed)[number]);
        return { outcome: "ok", result: await answer(args.command as string, true) };
      }
      direct.push({ command, args });
      return answer(command, false);
    });
    const view = render(
      <FederationProvider>
        <DockerAvailabilityProvider available>
          <SettingsPage open defaultSection="docker" onOpenChange={() => undefined} />
        </DockerAvailabilityProvider>
      </FederationProvider>,
    );
    if (scenario === "availability") {
      await screen.findByText("Checking Docker…");
    } else {
      await screen.findByText("Old container");
      if (scenario === "stats with reattach") {
        deferStats = true;
        await act(async () => {
          for (const callback of Array.from(callbacks.values())) callback();
        });
        fireEvent.click(screen.getByTitle("Reattach to project"));
        fireEvent.change(screen.getByRole("textbox"), { target: { value: "Old draft" } });
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Review cleanup…" }));
        if (scenario === "selected cleanup") await screen.findByText("Can be removed (1)");
        else
          await waitFor(() =>
            expect(routed.some((call) => call.command === "docker_cleanup_preview")).toBe(true),
          );
      }
      expect(screen.getByRole("alertdialog")).toBeTruthy();
    }
    const oldTimers = Array.from(callbacks.keys());
    const oldReads = routed.length;
    // Settings can change its selected machine while a previous view has pending work.
    act(() => useAccountMachineStore.getState().choose(null));
    await screen.findByText("New container");
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText("Old container")).toBeNull();
    expect(oldTimers.every((id) => !callbacks.has(id))).toBe(true);
    await act(async () =>
      resolveOld(
        scenario === "availability"
          ? { available: false, reason: null }
          : scenario === "stats with reattach"
            ? { containersRunning: 99, containersTotal: 99 }
            : preview(true),
      ),
    );
    expect(screen.getByText("New container")).toBeTruthy();
    expect(screen.queryByText(/Docker is not running/)).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByText(/Old orphan/)).toBeNull();
    await act(async () => {
      for (const callback of Array.from(callbacks.values())) callback();
    });
    expect(routed).toHaveLength(oldReads);
    expect(direct.filter((call) => call.command === "get_docker_system_stats")).toHaveLength(2);
    expect(
      direct.some(
        (call) =>
          call.command === "reattach_container" || call.command === "docker_cleanup_execute",
      ),
    ).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Review cleanup…" }));
    await screen.findByText("Can be removed (1)");
    expect(screen.getByText(/New orphan/)).toBeTruthy();
    expect(screen.queryByText(/Old orphan/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove 1 selected" }));
    await screen.findByText(/1 removed/);
    expect(direct.find((call) => call.command === "docker_cleanup_execute")?.args).toEqual({
      selectionToken: "new-token",
      containerIds: ["new-container"],
      volumeNames: [],
      networkNames: [],
    });
    expect(
      routed.some(
        (call) =>
          call.command === "docker_cleanup_execute" || call.command === "reattach_container",
      ),
    ).toBe(false);
    view.unmount();
    expect(callbacks.size).toBe(0);
  });
}
